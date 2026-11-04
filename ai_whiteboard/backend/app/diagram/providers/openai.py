from app.contracts.interfaces import Finished, ProviderError, TextDelta, Usage

from .common.http import HTTPProvider, provider_error, request_id, tokens
from .common.sse import events, object_data


class OpenAIDiagramProvider(HTTPProvider):
    async def stream(self, request):
        body = {
            "model": request.model,
            "instructions": request.instructions,
            "input": request.input_text,
            "max_output_tokens": request.max_output_tokens,
            "stream": True,
            "store": False,
            "tools": [],
            "tool_choice": "none",
        }
        self.temperature(request, body)
        if "reasoning_effort" in self.options:
            body["reasoning"] = {"effort": self.options["reasoning_effort"]}
        async with self.response(
            "https://api.openai.com/v1/responses",
            {"Authorization": f"Bearer {self._api_key}"},
            body,
        ) as response:
            upstream = request_id(response.headers)
            blocked = tool = False
            async for event in events(response):
                data = object_data(event)
                kind = data.get("type", event.name)
                if kind == "error":
                    raise provider_error(data, headers=response.headers)
                if kind in ("response.refusal.delta", "response.refusal.done"):
                    blocked = True
                elif kind in ("response.output_item.added", "response.output_item.done"):
                    item = data.get("item", {})
                    tool = tool or item.get("type") in (
                        "function_call",
                        "custom_tool_call",
                        "web_search_call",
                        "computer_call",
                        "code_interpreter_call",
                        "file_search_call",
                    )
                elif kind == "response.output_text.delta":
                    text = data.get("delta")
                    if not isinstance(text, str):
                        raise ProviderError(
                            "stream_interrupted", "Provider omitted its answer-text delta."
                        )
                    if text and not blocked and not tool:
                        yield TextDelta(text)
                elif kind in ("response.completed", "response.incomplete", "response.failed"):
                    result = data.get("response", {})
                    upstream = result.get("id") or upstream
                    if kind == "response.failed":
                        raise provider_error(result, headers=response.headers)
                    for item in result.get("output", []):
                        tool = tool or item.get("type") in (
                            "function_call",
                            "custom_tool_call",
                            "web_search_call",
                            "computer_call",
                            "code_interpreter_call",
                            "file_search_call",
                        )
                        blocked = blocked or any(
                            part.get("type") == "refusal" for part in item.get("content", [])
                        )
                    usage = result.get("usage")
                    if usage is not None:
                        yield Usage(
                            tokens(usage.get("input_tokens")),
                            tokens(usage.get("output_tokens")),
                            tokens((usage.get("input_tokens_details") or {}).get("cached_tokens")),
                            tokens(
                                (usage.get("output_tokens_details") or {}).get("reasoning_tokens")
                            ),
                        )
                    reason = "unknown"
                    if kind == "response.completed" and result.get("status") == "completed":
                        reason = "stop"
                    elif kind == "response.incomplete":
                        reason = {"max_output_tokens": "length", "content_filter": "blocked"}.get(
                            (result.get("incomplete_details") or {}).get("reason"), "unknown"
                        )
                    yield Finished(
                        "blocked" if blocked else "tool_call" if tool else reason,
                        upstream,
                        result.get("model"),
                        "openai",
                    )
                    return
                # Final text snapshots, reasoning, citations and tool arguments are never appended.
            raise ProviderError(
                "stream_interrupted", "Provider omitted its terminal response event."
            )
