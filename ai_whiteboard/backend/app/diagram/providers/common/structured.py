"""Typed response envelope and bounded standard JSON decoding; no output repair."""

import json

from jsonschema import Draft202012Validator, ValidationError
from pydantic import BaseModel, ConfigDict

from app.contracts.interfaces import Finished, ProviderError, TextDelta
from app.contracts.operations import Operation

from .chat import chat_events
from .http import chat_usage


class DiagramResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operations: list[Operation]
    no_change_reason: str


def strict_schema():
    schema = DiagramResponse.model_json_schema()

    def visit(value):
        if isinstance(value, dict):
            value.pop("default", None)
            value.pop("discriminator", None)
            value.pop("not", None)
            if "oneOf" in value:
                value["anyOf"] = value.pop("oneOf")
            if value.get("type") == "object":
                value["additionalProperties"] = False
                value["required"] = list(value.get("properties", {}))
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(schema)
    # Keep NodeAdd an object; encode placement as a single exclusive union.
    node = schema["$defs"]["NodeAdd"]
    at = node["properties"].pop("at")
    place = node["properties"].pop("place")
    node["required"] = [key for key in node["required"] if key not in ("at", "place")]
    node["properties"]["placement"] = {
        "anyOf": [
            {
                "type": "object",
                "properties": {"at": at["anyOf"][0]},
                "required": ["at"],
                "additionalProperties": False,
            },
            {
                "type": "object",
                "properties": {"place": place["anyOf"][0]},
                "required": ["place"],
                "additionalProperties": False,
            },
            {"type": "null"},
        ]
    }
    node["required"].append("placement")
    return schema


def configure(body, streaming):
    data = json.loads(body["messages"][1]["content"])
    aliases = {}
    for kind in ("sections", "nodes", "edges"):
        for index, entity in enumerate(data["board"][kind]):
            aliases[entity["id"]] = kind[0] + str(index)
    original_prefix = data["idPrefix"]
    id_fields = {
        "id",
        "sectionId",
        "section",
        "from",
        "to",
        "rightOf",
        "leftOf",
        "above",
        "below",
        "activeSectionId",
    }

    def encode(value, key=None):
        if isinstance(value, dict):
            return {k: encode(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [encode(v, key) for v in value]
        if isinstance(value, str) and (key in id_fields or key == "selectedIds"):
            return aliases.get(value, value)
        return value

    data.pop("operationExamplesNdjson", None)
    data = encode(data)
    data["idPrefix"] = "new_"
    # This is model context only. The canonical snapshot remains complete for
    # revision/protection validation and replay; every entity and reference stays.
    for key in ("protocolVersion", "requestId", "sessionId", "sessionEpoch", "baseRevision"):
        data.pop(key, None)
    data["transcript"] = {"text": data["transcript"]["text"]} if "transcript" in data else {}
    for kind in ("nodes", "edges"):
        for entity in data["board"][kind]:
            entity.pop("revision", None)
            for key, default in (("source", "generated"), ("locked", False), ("color", "neutral")):
                if entity.get(key) == default:
                    entity.pop(key)
    data["boardDefaults"] = {"source": "generated", "locked": False, "color": "neutral"}
    body["messages"][1]["content"] = json.dumps(data, separators=(",", ":"))
    body["stream"] = streaming
    for key in ("tools", "tool_choice"):
        body.pop(key, None)
    if not streaming:
        body.pop("stream_options", None)
    body["response_format"] = {
        "type": "json_schema",
        "json_schema": {
            "name": "diagram_changes",
            "strict": True,
            "schema": strict_schema(),
        },
    }
    body["messages"][0]["content"] += (
        "\nOUTPUT FORMAT OVERRIDE: Return one JSON object with operations and no_change_reason. "
        "Do not return NDJSON. Use null for unused nullable fields. "
        "In board context, omitted source/locked/color use boardDefaults. "
        "For node.add use placement:{at:[x,y]}, placement:{place:{rightOf:ID}} "
        "(or leftOf/above/below), or placement:null for automatic layout. "
        "Do not emit top-level at or place on node.add. "
        "When operations is empty, explain why in no_change_reason; otherwise use an empty string."
    )
    return {alias: canonical for canonical, alias in aliases.items()}, original_prefix


async def decode(response, streaming, identity):
    limit = 1024 * 1024
    if streaming:
        chunks, size, terminal = [], 0, None
        async for event in chat_events(response, repeated_finish=True):
            if isinstance(event, TextDelta):
                size += len(event.text.encode("utf-8"))
                if size > limit:
                    raise ProviderError("output_limit", "Structured response exceeds byte limit.")
                chunks.append(event.text)
            elif isinstance(event, Finished):
                terminal = event
            else:
                yield event
        content = "".join(chunks)
    else:
        payload = bytearray()
        async for chunk in response.aiter_bytes():
            payload.extend(chunk)
            if len(payload) > limit:
                raise ProviderError("output_limit", "Structured response exceeds byte limit.")
        data = json.loads(payload)
        choice = data["choices"][0]
        message = choice["message"]
        if message.get("refusal"):
            raise ProviderError("content_blocked", "Provider declined generation.")
        content = message.get("content")
        reason = choice.get("finish_reason")
        terminal = Finished(reason if reason in ("stop", "length") else "unknown", data.get("id"))
        if data.get("usage"):
            yield chat_usage(data["usage"])
    if terminal is None or terminal.reason != "stop":
        raise ProviderError("output_limit", "Structured response did not complete.")
    try:
        result = json.loads(content)
        schema = strict_schema()
        # Validate the envelope separately so one bad operation does not discard siblings.
        envelope = {
            **schema,
            "properties": {**schema["properties"], "operations": {"type": "array"}},
        }
        Draft202012Validator(envelope).validate(result)
    except (ValueError, TypeError, ValidationError) as exc:
        raise ProviderError(
            "invalid_output", "Provider response failed diagram envelope validation."
        ) from exc
    aliases, prefix = identity
    fields = {"id", "section", "from", "to", "rightOf", "leftOf", "above", "below"}

    def canonical(value, key=None):
        if isinstance(value, dict):
            if value.get("op") == "node.add" and "placement" in value:
                value = dict(value)
                placement = value.pop("placement")
                if placement is not None:
                    value.update(placement)
            # Explicit nullable provider fields map to omitted optional wire fields.
            return {k: canonical(v, k) for k, v in value.items() if v is not None}
        if isinstance(value, list):
            return [canonical(v, key) for v in value]
        if isinstance(value, str) and key in fields:
            return aliases.get(value, prefix + value[4:] if value.startswith("new_") else value)
        return value

    if not result["operations"] and not result["no_change_reason"].strip():
        raise ProviderError("invalid_output", "Empty diagram response omitted its reason.")
    operation_schema = {
        "$defs": schema.get("$defs", {}),
        **schema["properties"]["operations"]["items"],
    }
    validator = Draft202012Validator(operation_schema)
    for operation in result["operations"]:
        if validator.is_valid(operation):
            operation = canonical(operation)
        yield TextDelta(json.dumps(operation) + "\n")
    yield terminal
