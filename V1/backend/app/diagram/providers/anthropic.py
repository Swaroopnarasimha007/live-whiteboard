from app.contracts.interfaces import Finished, ProviderError, TextDelta, Usage

from .common.http import HTTPProvider, provider_error, request_id, tokens
from .common.sse import events, object_data


class AnthropicDiagramProvider(HTTPProvider):
    async def stream(self, request):
        body = {
            "model": request.model,
            "system": request.instructions,
            "messages": [{"role": "user", "content": request.input_text}],
            "max_tokens": request.max_output_tokens,
            "stream": True,
            "tools": [],
        }
        self.temperature(request, body)
        if "thinking_budget" in self.options:
            body["thinking"] = {"type": "enabled", "budget_tokens": self.options["thinking_budget"]}
        async with self.response(
            "https://api.anthropic.com/v1/messages",
            {"x-api-key": self._api_key, "anthropic-version": "2023-06-01"},
            body,
        ) as response:
            blocks = {}
            reason = None
            tool = blocked = False
            upstream = request_id(response.headers)
            model = None
            message_started = False
            async for event in events(response):
                data = object_data(event)
                kind = data.get("type", event.name)
                if kind == "error":
                    raise provider_error(data, headers=response.headers)
                if kind == "message_start":
                    if message_started:
                        raise ProviderError(
                            "stream_interrupted", "Provider restarted a message inside one stream."
                        )
                    message_started = True
                    message = data.get("message", {})
                    upstream, model = message.get("id") or upstream, message.get("model")
                    usage = message.get("usage")
                    if usage is not None:
                        yield Usage(
                            tokens(usage.get("input_tokens")),
                            tokens(usage.get("output_tokens")),
                            tokens(usage.get("cache_read_input_tokens")),
                        )
                elif kind == "content_block_start":
                    block = data.get("content_block", {})
                    blocks[data["index"]] = block.get("type")
                    tool = tool or block.get("type") in ("tool_use", "server_tool_use")
                    blocked = blocked or block.get("type") == "refusal"
                    if (
                        block.get("type") == "text"
                        and block.get("text")
                        and not blocked
                        and not tool
                    ):
                        yield TextDelta(block["text"])
                elif kind == "content_block_delta":
                    delta = data.get("delta", {})
                    if (
                        delta.get("type") == "text_delta"
                        and blocks.get(data.get("index")) == "text"
                    ):
                        text = delta.get("text")
                        if not isinstance(text, str):
                            raise ProviderError(
                                "stream_interrupted", "Provider text delta is invalid."
                            )
                        if text and not blocked and not tool:
                            yield TextDelta(text)
                elif kind == "message_delta":
                    stop = (data.get("delta") or {}).get("stop_reason")
                    if stop:
                        normalized = {
                            "end_turn": "stop",
                            "stop_sequence": "stop",
                            "max_tokens": "length",
                            "refusal": "blocked",
                            "tool_use": "tool_call",
                        }.get(stop, "unknown")
                        if reason is not None and reason != normalized:
                            raise ProviderError(
                                "stream_interrupted", "Provider sent contradictory stop reasons."
                            )
                        reason = normalized
                    usage = data.get("usage")
                    if usage is not None:
                        yield Usage(
                            tokens(usage.get("input_tokens")),
                            tokens(usage.get("output_tokens")),
                            tokens(usage.get("cache_read_input_tokens")),
                        )
                elif kind == "message_stop":
                    if reason is None or not message_started:
                        raise ProviderError(
                            "stream_interrupted", "Provider omitted its stop reason."
                        )
                    yield Finished(
                        "blocked" if blocked else "tool_call" if tool else reason,
                        upstream,
                        model,
                        "anthropic",
                    )
                    return
            raise ProviderError("stream_interrupted", "Provider omitted its message-stop event.")
