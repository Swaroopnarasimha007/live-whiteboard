from .common.chat import chat_events
from .common.http import HTTPProvider
from .common.structured import configure, decode


class OpenRouterDiagramProvider(HTTPProvider):
    async def stream(self, request):
        body = {
            "model": request.model,
            "messages": [
                {"role": "system", "content": request.instructions},
                {"role": "user", "content": request.input_text},
            ],
            "stream": True,
            "n": 1,
            "stream_options": {"include_usage": True},
            "tools": [],
            "tool_choice": "none",
            "max_tokens": request.max_output_tokens,
            "provider": {
                "allow_fallbacks": False,
                "require_parameters": True,
                **self.options.get("provider", {}),
            },
        }
        self.temperature(request, body)
        if "reasoning_effort" in self.options:
            body["reasoning"] = {"effort": self.options["reasoning_effort"], "exclude": True}
        if self.capabilities.structured_output:
            identity = configure(body, self.capabilities.structured_output_streaming)
        async with self.response(
            "https://openrouter.ai/api/v1/chat/completions",
            {"Authorization": f"Bearer {self._api_key}"},
            body,
        ) as response:
            events = (
                decode(response, self.capabilities.structured_output_streaming, identity)
                if self.capabilities.structured_output
                else chat_events(response, repeated_finish=True)
            )
            async for event in events:
                yield event
