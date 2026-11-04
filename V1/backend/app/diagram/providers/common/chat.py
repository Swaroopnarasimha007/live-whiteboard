from app.contracts.interfaces import Finished, ProviderError, TextDelta

from .http import chat_usage, provider_error, request_id
from .sse import events, object_data


async def chat_events(response, *, repeated_finish=False):
    reason = None
    blocked = tool = False
    upstream = request_id(response.headers)
    model = host = None
    answer_started = False
    prefix = ""
    async for event in events(response):
        if event.data == "[DONE]":
            if reason is None:
                raise ProviderError("stream_interrupted", "Provider omitted its completion reason.")
            yield Finished(
                "blocked" if blocked else "tool_call" if tool else reason, upstream, model, host
            )
            if prefix:
                yield TextDelta(prefix)
            return
        data = object_data(event)
        if "error" in data:
            raise provider_error(data, headers=response.headers)
        upstream = data.get("id") or upstream
        model, host = data.get("model", model), data.get("provider", host)
        usage = data.get("usage") or (data.get("x_groq") or {}).get("usage")
        if usage is not None:
            yield chat_usage(usage)
        for choice in data.get("choices", []):
            if choice.get("index", 0) != 0:
                continue
            delta = choice.get("delta") or {}
            blocked = blocked or bool(delta.get("refusal"))
            tool = tool or bool(delta.get("tool_calls") or delta.get("function_call"))
            text = delta.get("content")
            if text is not None and not isinstance(text, str):
                raise ProviderError("stream_interrupted", "Provider content delta is not text.")
            if text and not blocked and not tool:
                if reason is not None:
                    raise ProviderError(
                        "stream_interrupted", "Provider sent answer text after completion."
                    )
                if not answer_started:
                    prefix += text
                    stripped = prefix.lstrip()
                    if not stripped:
                        if len(prefix) > 1024:
                            raise ProviderError(
                                "invalid_output", "Provider emitted excessive leading whitespace."
                            )
                        text = ""
                    elif stripped.startswith("<"):
                        raise ProviderError(
                            "unsupported_parameter",
                            "Provider returned inline markup/reasoning. Configure a verified answer-only reasoning mode.",
                        )
                    else:
                        answer_started = True
                        text, prefix = prefix, ""
                if text:
                    yield TextDelta(text)
            finish = choice.get("finish_reason")
            if finish is not None:
                normalized = {
                    "stop": "stop",
                    "length": "length",
                    "content_filter": "blocked",
                    "tool_calls": "tool_call",
                    "function_call": "tool_call",
                }.get(finish, "unknown")
                if reason is not None and (not repeated_finish or reason != normalized):
                    raise ProviderError(
                        "stream_interrupted", "Provider sent contradictory completion metadata."
                    )
                reason = normalized
    raise ProviderError("stream_interrupted", "Provider ended before its stream completion marker.")
