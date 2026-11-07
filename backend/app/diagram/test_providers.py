import asyncio
import json
from contextlib import asynccontextmanager

import httpx
import pytest

from app.config.settings import ModelCapabilities
from app.contracts.interfaces import Finished, LLMRequest, ProviderError, TextDelta, Usage
from app.diagram.providers.common.http import merge_usage
from app.diagram.registry import PROVIDERS

NAMES = list(PROVIDERS)
PARAMETERS = {
    "groq": "max_completion_tokens",
    "openrouter": "max_tokens",
    "openai": "max_output_tokens",
    "gemini": "maxOutputTokens",
    "anthropic": "max_tokens",
}
TEXT = '{"op":"section.add","id":"g_r1_section","title":"café 日本語"}\n'


def sse(data, kind=None):
    return (
        (f"event: {kind}\n" if kind else "")
        + "data: "
        + (data if isinstance(data, str) else json.dumps(data, ensure_ascii=False))
        + "\n\n"
    ).encode("utf-8")


def frames(
    name, texts=(TEXT[:20], TEXT[20:]), reason="stop", *, terminal=True, tool=False, refusal=False
):
    out = [b": keepalive\n\n"]
    if name in ("groq", "openrouter"):
        out.append(
            sse(
                {
                    "id": "remote-1",
                    "model": "actual-model",
                    "provider": "actual-host",
                    "choices": [],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 1},
                }
            )
        )
        out.append(
            sse(
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "reasoning_content": "NEVER_PARSE_THIS",
                                **(
                                    {"tool_calls": [{"function": {"arguments": TEXT}}]}
                                    if tool
                                    else {}
                                ),
                                **({"refusal": "refused"} if refusal else {}),
                            },
                        }
                    ]
                }
            )
        )
        out.extend(sse({"choices": [{"index": 0, "delta": {"content": text}}]}) for text in texts)
        if terminal:
            finish = {
                "stop": "stop",
                "length": "length",
                "blocked": "content_filter",
                "tool_call": "tool_calls",
                "unknown": "future_reason",
            }[reason]
            end = {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}
            out.append(sse(end))
            if name == "openrouter":
                out.append(sse(end))
            out.append(sse({"choices": [], "usage": {"completion_tokens": 2}}))
            out.append(sse("[DONE]"))
    elif name == "openai":
        out.append(sse({"type": "response.reasoning_text.delta", "delta": "NEVER_PARSE_THIS"}))
        if tool:
            out.append(
                sse(
                    {
                        "type": "response.output_item.added",
                        "item": {"type": "function_call", "arguments": TEXT},
                    }
                )
            )
        if refusal:
            out.append(sse({"type": "response.refusal.delta", "delta": TEXT}))
        out.extend(sse({"type": "response.output_text.delta", "delta": text}) for text in texts)
        out.append(sse({"type": "response.output_text.done", "text": "".join(texts)}))
        if terminal:
            status = "completed" if reason == "stop" else "incomplete"
            out.append(
                sse(
                    {
                        "type": f"response.{status}",
                        "response": {
                            "id": "remote-1",
                            "model": "actual-model",
                            "status": status,
                            "usage": {"input_tokens": 10, "output_tokens": 2},
                            "incomplete_details": {
                                "reason": {
                                    "length": "max_output_tokens",
                                    "blocked": "content_filter",
                                }.get(reason, "future_reason")
                            },
                        },
                    }
                )
            )
    elif name == "gemini":
        out.append(
            sse(
                {
                    "responseId": "remote-1",
                    "modelVersion": "actual-model",
                    "candidates": [
                        {"content": {"parts": [{"text": "NEVER_PARSE_THIS", "thought": True}]}}
                    ],
                }
            )
        )
        if tool:
            out.append(
                sse(
                    {
                        "candidates": [
                            {
                                "content": {
                                    "parts": [
                                        {"functionCall": {"name": "bad", "args": {"payload": TEXT}}}
                                    ]
                                }
                            }
                        ]
                    }
                )
            )
        if refusal:
            out.append(sse({"promptFeedback": {"blockReason": "SAFETY"}}))
        if not refusal:
            out.extend(
                sse({"candidates": [{"index": 0, "content": {"parts": [{"text": text}]}}]})
                for text in texts
            )
        if terminal:
            if not refusal:
                finish = {
                    "stop": "STOP",
                    "length": "MAX_TOKENS",
                    "blocked": "SAFETY",
                    "tool_call": "STOP",
                    "unknown": "FUTURE_REASON",
                }[reason]
                out.append(sse({"candidates": [{"finishReason": finish}]}))
            out.append(sse({"usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 2}}))
    else:
        out.append(
            sse(
                {
                    "type": "message_start",
                    "message": {
                        "id": "remote-1",
                        "model": "actual-model",
                        "usage": {"input_tokens": 10, "output_tokens": 0},
                    },
                }
            )
        )
        out.append(
            sse({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking"}})
        )
        out.append(
            sse(
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "thinking_delta", "thinking": "NEVER_PARSE_THIS"},
                }
            )
        )
        if tool:
            out.append(
                sse(
                    {
                        "type": "content_block_start",
                        "index": 2,
                        "content_block": {"type": "tool_use", "input": {"payload": TEXT}},
                    }
                )
            )
        if refusal:
            out.append(
                sse(
                    {
                        "type": "content_block_start",
                        "index": 3,
                        "content_block": {"type": "refusal"},
                    }
                )
            )
        out.append(
            sse(
                {
                    "type": "content_block_start",
                    "index": 1,
                    "content_block": {"type": "text", "text": ""},
                }
            )
        )
        out.extend(
            sse(
                {
                    "type": "content_block_delta",
                    "index": 1,
                    "delta": {"type": "text_delta", "text": text},
                }
            )
            for text in texts
        )
        if terminal:
            finish = {
                "stop": "end_turn",
                "length": "max_tokens",
                "blocked": "refusal",
                "tool_call": "tool_use",
                "unknown": "future_reason",
            }[reason]
            out.append(
                sse(
                    {
                        "type": "message_delta",
                        "delta": {"stop_reason": finish},
                        "usage": {"output_tokens": 2},
                    }
                )
            )
            out.append(sse({"type": "message_stop"}))
    return out


class Stream(httpx.AsyncByteStream):
    def __init__(self, chunks, fragment=3):
        self.chunks, self.fragment, self.closed = chunks, fragment, False

    async def __aiter__(self):
        for chunk in self.chunks:
            if isinstance(chunk, float):
                await asyncio.sleep(chunk)
            else:
                for offset in range(0, len(chunk), self.fragment):
                    yield chunk[offset : offset + self.fragment]

    async def aclose(self):
        self.closed = True


@asynccontextmanager
async def adapter(name, chunks, *, status=200, headers=None, fragment=3):
    streams = []
    requests = []

    def handle(request):
        requests.append(request)
        stream = Stream(chunks, fragment)
        streams.append(stream)
        return httpx.Response(
            status,
            headers={
                "content-type": "text/event-stream",
                "x-request-id": "header-id",
                **(headers or {}),
            },
            stream=stream,
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = PROVIDERS[name](
            api_key="FAKE_SECRET",
            capabilities=ModelCapabilities(
                verified=True, token_limit_parameter=PARAMETERS[name], temperature_support=True
            ),
            client=client,
        )
        yield provider, streams, requests, client


def llm():
    return LLMRequest("r1", "test-model", "instructions", "user context", 128)


@pytest.mark.parametrize("name", NAMES)
def test_every_adapter_preserves_text_usage_and_single_terminal(name):
    async def run():
        async with adapter(name, frames(name)) as (provider, streams, requests, client):
            events = [e async for e in provider.stream(llm())]
            assert "".join(e.text for e in events if isinstance(e, TextDelta)) == TEXT
            assert sum(isinstance(e, Finished) for e in events) == 1
            assert isinstance(events[-1], Finished) and events[-1].reason == "stop"
            assert events[-1].provider_request_id == "remote-1"
            usage = Usage(None, None)
            for e in events:
                if isinstance(e, Usage):
                    usage = merge_usage(usage, e)
            assert usage.input_tokens == 10 and usage.output_tokens == 2
            assert usage.cached_input_tokens is None
            assert streams[0].closed and not client.is_closed
            body = json.loads(requests[0].content)
            assert body.get("stream", True) is True
            assert "FAKE_SECRET" not in str(requests[0].url)
            assert "response_format" not in body
            await provider.aclose()
            assert not client.is_closed

    asyncio.run(run())


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize("reason", ["length", "blocked", "unknown"])
def test_adapter_stop_reasons_are_not_guessed_as_success(name, reason):
    async def run():
        async with adapter(name, frames(name, reason=reason)) as (provider, streams, _, _):
            result = [e async for e in provider.stream(llm())]
            assert result[-1].reason == reason
            assert streams[0].closed

    asyncio.run(run())


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize("kind", ["tool", "refusal"])
def test_non_answer_blocks_never_enter_text_stream(name, kind):
    async def run():
        async with adapter(name, frames(name, tool=kind == "tool", refusal=kind == "refusal")) as (
            provider,
            _,
            _,
            _,
        ):
            result = [e async for e in provider.stream(llm())]
            assert not any(isinstance(e, TextDelta) for e in result)
            assert result[-1].reason == ("tool_call" if kind == "tool" else "blocked")

    asyncio.run(run())


@pytest.mark.parametrize("name", NAMES)
def test_eof_without_native_terminal_is_interrupted(name):
    async def run():
        async with adapter(name, frames(name, terminal=False)) as (provider, streams, _, _):
            with pytest.raises(ProviderError) as caught:
                _ = [e async for e in provider.stream(llm())]
            assert caught.value.code == "stream_interrupted" and streams[0].closed

    asyncio.run(run())


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize(
    "status,expected",
    [
        (401, "authentication_failed"),
        (403, "permission_denied"),
        (404, "model_unavailable"),
        (429, "rate_limited"),
        (503, "provider_unavailable"),
    ],
)
def test_http_errors_are_safe_and_carry_retry_metadata(name, status, expected):
    async def run():
        async with adapter(
            name,
            [b'{"error":{"message":"FAKE_SECRET private raw body"}}'],
            status=status,
            headers={"retry-after": "2"},
        ) as (provider, streams, _, _):
            with pytest.raises(ProviderError) as caught:
                _ = [e async for e in provider.stream(llm())]
            assert caught.value.code == expected and "FAKE_SECRET" not in str(caught.value)
            assert caught.value.retry_after == 2 and caught.value.upstream_request_id == "header-id"
            assert streams[0].closed

    asyncio.run(run())


@pytest.mark.parametrize("name", NAMES)
def test_mid_stream_error_preserves_earlier_deltas_and_closes(name):
    async def run():
        chunks = frames(name, texts=(TEXT,), terminal=False)
        chunks.append(
            sse({"type": "error", "error": {"type": "rate_limit_error", "message": "FAKE_SECRET"}})
        )
        async with adapter(name, chunks) as (provider, streams, _, _):
            text = []
            with pytest.raises(ProviderError) as caught:
                async for event in provider.stream(llm()):
                    if isinstance(event, TextDelta):
                        text.append(event.text)
            assert "".join(text) == TEXT and caught.value.code == "rate_limited"
            assert streams[0].closed

    asyncio.run(run())


@pytest.mark.parametrize("name", NAMES)
def test_cancellation_closes_one_request_and_shared_client_still_works(name):
    async def run():
        chunks = frames(name, texts=(TEXT,), terminal=False) + [30.0]
        async with adapter(name, chunks) as (provider, streams, requests, client):
            iterator = provider.stream(llm())
            while not isinstance(await anext(iterator), TextDelta):
                pass
            pending = asyncio.create_task(anext(iterator))
            await asyncio.sleep(0)
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
            await iterator.aclose()
            assert streams[0].closed and not client.is_closed
            # Same client/adapter, different request. No aclose() of the shared client on cancel.
            chunks[:] = frames(name)
            result = [e async for e in provider.stream(llm())]
            assert result[-1].reason == "stop" and len(requests) == 2

    asyncio.run(run())


@pytest.mark.parametrize("name", NAMES)
def test_malformed_sse_and_utf8_fail_without_exposing_raw_body(name):
    async def run():
        for payload in (b"data: {BAD FAKE_SECRET}\n\n", b"data: \xff\n\n", b"data: {}"):
            async with adapter(name, [payload]) as (provider, streams, _, _):
                with pytest.raises(ProviderError) as caught:
                    _ = [e async for e in provider.stream(llm())]
                assert caught.value.code == "stream_interrupted" and "FAKE_SECRET" not in str(
                    caught.value
                )
                assert streams[0].closed

    asyncio.run(run())


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize(
    "code,expected",
    [
        ("insufficient_quota", "quota_exceeded"),
        ("context_length_exceeded", "context_too_large"),
        ("unsupported_parameter", "unsupported_parameter"),
    ],
)
def test_structured_provider_error_codes_are_preserved(name, code, expected):
    async def run():
        body = json.dumps({"error": {"code": code, "message": "PRIVATE RAW ERROR"}}).encode()
        async with adapter(name, [body], status=400) as (provider, _, _, _):
            with pytest.raises(ProviderError) as caught:
                _ = [event async for event in provider.stream(llm())]
            assert caught.value.code == expected and "PRIVATE" not in str(caught.value)

    asyncio.run(run())


def test_sse_multiline_data_and_byte_limit():
    from app.diagram.providers.common.sse import events, object_data

    async def run():
        payload = b'event: example\r\ndata: {"key":\r\ndata: "value"}\r\n\r\n'
        response = httpx.Response(200, stream=Stream([payload], 1))
        parsed = [event async for event in events(response)]
        assert len(parsed) == 1 and parsed[0].name == "example"
        assert object_data(parsed[0]) == {"key": "value"}
        await response.aclose()
        response = httpx.Response(200, stream=Stream([b"data: " + b"x" * 65 + b"\n\n"]))
        with pytest.raises(ProviderError) as caught:
            _ = [event async for event in events(response, maximum=64)]
        assert caught.value.code == "invalid_output"
        await response.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("name", ["groq", "openrouter"])
def test_inline_reasoning_is_rejected_before_any_answer_delta(name):
    async def run():
        async with adapter(name, frames(name, texts=("<", "think>\n" + TEXT + "</think>"))) as (
            provider,
            streams,
            _,
            _,
        ):
            received = []
            with pytest.raises(ProviderError) as caught:
                async for event in provider.stream(llm()):
                    if isinstance(event, TextDelta):
                        received.append(event.text)
            assert (
                received == []
                and caught.value.code == "unsupported_parameter"
                and streams[0].closed
            )
        async with adapter(name, frames(name, texts=(" ", "\t", TEXT))) as (provider, _, _, _):
            result = [event async for event in provider.stream(llm())]
            assert "".join(e.text for e in result if isinstance(e, TextDelta)) == " \t" + TEXT

    asyncio.run(run())


def test_gemini_safety_frame_does_not_forward_its_text_payload():
    async def run():
        blocked = sse(
            {"candidates": [{"finishReason": "SAFETY", "content": {"parts": [{"text": TEXT}]}}]}
        )
        async with adapter("gemini", [blocked]) as (provider, _, _, _):
            result = [event async for event in provider.stream(llm())]
            assert not any(isinstance(event, TextDelta) for event in result)
            assert result[-1].reason == "blocked"

    asyncio.run(run())
