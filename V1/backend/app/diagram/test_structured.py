import asyncio
import json

import httpx
import pytest
from jsonschema import Draft202012Validator

from app.config.settings import ModelCapabilities
from app.contracts.interfaces import Finished, LLMRequest, ProviderError, TextDelta
from app.diagram.providers.common.http import provider_error
from app.diagram.providers.common.structured import configure, decode, strict_schema
from app.diagram.providers.groq import GroqDiagramProvider


def body():
    return {
        "messages": [
            {"content": "instructions"},
            {
                "content": json.dumps(
                    {
                        "idPrefix": "canonical_",
                        "board": {
                            "sections": [{"id": "original_section"}],
                            "nodes": [],
                            "edges": [],
                        },
                    }
                )
            },
        ],
        "stream_options": {},
        "tools": [],
        "tool_choice": "none",
    }


def test_provider_schema_enforces_exclusive_placement():
    schema = strict_schema()
    assert schema["$defs"]["NodeAdd"]["type"] == "object"
    validator = Draft202012Validator(schema)
    node = {
        "op": "node.add",
        "id": "new_a",
        "section": "s0",
        "type": "rect",
        "label": "API gateway",
        "color": "blue",
        "placement": {"at": [0, 0], "place": {"rightOf": "n0"}},
    }
    envelope = {"operations": [node], "no_change_reason": ""}
    assert not validator.is_valid(envelope)
    for placement in ({"at": [0, 0]}, {"place": {"rightOf": "n0"}}, None):
        node["placement"] = placement
        assert validator.is_valid(envelope)


@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("placement", [{"at": [0, 0]}, {"place": {"rightOf": "new_anchor"}}, None])
def test_explicit_placement_converts_to_canonical_protocol(streaming, placement):
    node = {
        "op": "node.add",
        "id": "new_a",
        "section": "s0",
        "type": "rect",
        "label": "Gateway",
        "color": "blue",
        "placement": placement,
    }
    events = run(json.dumps({"operations": [node], "no_change_reason": ""}), streaming)
    op = json.loads(next(e.text for e in events if isinstance(e, TextDelta)))
    assert "placement" not in op
    assert op["id"] == "canonical_a"
    if placement is None:
        assert "at" not in op and "place" not in op
    elif "at" in placement:
        assert op["at"] == [0, 0] and "place" not in op
    else:
        assert op["place"] == {"rightOf": "canonical_anchor"} and "at" not in op


def test_provider_generation_failure_is_not_a_configuration_error():
    error = provider_error(
        {"error": {"code": "json_validate_failed", "type": "invalid_request_error"}}, status=400
    )
    assert error.code == "invalid_output"
    assert provider_error({"error": {"code": []}}, status=400).code == "unsupported_parameter"


def run(content, streaming=False):
    async def collect():
        request = body()
        identity = configure(request, streaming)
        if streaming:
            events = [
                {"choices": [{"delta": {"content": content}, "index": 0}]},
                {"choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]},
            ]
            response = httpx.Response(
                200,
                content="".join("data: " + json.dumps(e) + "\n\n" for e in events)
                + "data: [DONE]\n\n",
            )
        else:
            response = httpx.Response(
                200, json={"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}
            )
        return [event async for event in decode(response, streaming, identity)]

    return asyncio.run(collect())


@pytest.mark.parametrize("streaming", [False, True])
def test_structured_identity_and_nullable_fields(streaming):
    events = run(
        json.dumps(
            {
                "operations": [
                    {
                        "op": "node.add",
                        "id": "new_a",
                        "section": "s0",
                        "type": "rect",
                        "label": "Browser",
                        "color": "blue",
                        "placement": {"at": [0, 0]},
                    }
                ],
                "no_change_reason": "",
            }
        ),
        streaming,
    )
    op = json.loads(next(e.text for e in events if isinstance(e, TextDelta)))
    assert op["id"] == "canonical_a"
    assert op["section"] == "original_section"
    assert "place" not in op
    assert isinstance(events[-1], Finished)


def test_malformed_response_is_not_repaired():
    with pytest.raises(ProviderError, match="envelope"):
        run("```json\n{}\n```")


def test_no_stream_request_has_no_stream_or_tool_parameters():
    request = body()
    configure(request, False)
    assert request["stream"] is False
    assert "stream_options" not in request and "tools" not in request
    assert request["response_format"]["json_schema"]["strict"] is True


def test_context_compaction_preserves_protected_entities_and_references():
    request = body()
    data = json.loads(request["messages"][1]["content"])
    data.update(
        requestId="request",
        sessionId="session",
        baseRevision=4,
        transcript={"text": "Return the response", "segmentIds": ["long_segment"], "startMs": 0},
    )
    data["board"]["nodes"] = [
        {
            "id": "generated_node",
            "source": "generated",
            "locked": False,
            "color": "neutral",
            "revision": 4,
            "x": 176,
            "y": 96,
            "width": 312,
            "height": 80,
        },
        {"id": "manual_node", "source": "manual", "locked": True, "color": "red", "revision": 3},
    ]
    data["board"]["edges"] = [{"id": "edge", "from": "generated_node", "to": "manual_node"}]
    request["messages"][1]["content"] = json.dumps(data)
    identity, _ = configure(request, False)
    compact = json.loads(request["messages"][1]["content"])
    assert "sessionId" not in compact and "baseRevision" not in compact
    assert compact["transcript"] == {"text": "Return the response"}
    generated, manual = compact["board"]["nodes"]
    assert "revision" not in generated and "source" not in generated
    assert {key: generated[key] for key in ("x", "y", "width", "height")} == {
        "x": 176, "y": 96, "width": 312, "height": 80
    }
    assert manual["source"] == "manual" and manual["locked"] is True
    assert identity[compact["board"]["edges"][0]["to"]] == "manual_node"
    assert compact["boardDefaults"]["source"] == "generated"


def test_groq_complete_response_through_http_adapter():
    async def scenario():
        def handler(request):
            payload = json.loads(request.content)
            assert payload["stream"] is False
            assert payload["response_format"]["json_schema"]["strict"] is True
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {
                                "content": json.dumps(
                                    {"operations": [], "no_change_reason": "Already represented"}
                                )
                            },
                        }
                    ]
                },
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = GroqDiagramProvider(
                api_key="test",
                client=client,
                capabilities=ModelCapabilities(structured_output=True),
            )
            request = LLMRequest(
                "request", "test", "instructions", body()["messages"][1]["content"], 1024
            )
            events = [e async for e in provider.stream(request)]
            assert isinstance(events[-1], Finished)

    asyncio.run(scenario())
