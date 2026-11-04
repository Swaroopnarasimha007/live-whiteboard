from .common.chat import chat_events
from .common.http import HTTPProvider
from .common.structured import configure, decode


class GroqDiagramProvider(HTTPProvider):
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
            self.capabilities.token_limit_parameter: request.max_output_tokens,
        }
        self.temperature(request, body)
        if "reasoning_effort" in self.options:
            body["reasoning_effort"] = self.options["reasoning_effort"]
        if "reasoning_format" in self.options:
            body["reasoning_format"] = self.options.get("reasoning_format", "hidden")
        elif "include_reasoning" in self.options:
            body["include_reasoning"] = False
        elif "reasoning_format" in self.capabilities.reasoning_controls:
            body["reasoning_format"] = "hidden"
        elif "include_reasoning" in self.capabilities.reasoning_controls:
            body["include_reasoning"] = False
        if self.capabilities.structured_output:
            identity = configure(body, self.capabilities.structured_output_streaming)
        async with self.response(
            "https://api.groq.com/openai/v1/chat/completions",
            {"Authorization": f"Bearer {self._api_key}"},
            body,
        ) as response:
            events = (
                decode(response, self.capabilities.structured_output_streaming, identity)
                if self.capabilities.structured_output
                else chat_events(response)
            )
            async for event in events:
                yield event
