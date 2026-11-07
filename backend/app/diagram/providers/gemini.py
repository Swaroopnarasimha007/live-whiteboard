from urllib.parse import quote

from app.contracts.interfaces import Finished, ProviderError, TextDelta, Usage

from .common.http import HTTPProvider, provider_error, request_id, tokens
from .common.sse import events, object_data


class GeminiDiagramProvider(HTTPProvider):
    async def stream(self, request):
        generation = {"maxOutputTokens": request.max_output_tokens, "candidateCount": 1}
        self.temperature(request, generation)
        if "thinking_budget" in self.options:
            generation["thinkingConfig"] = {
                "thinkingBudget": self.options["thinking_budget"],
                "includeThoughts": False,
            }
        if "thinking_level" in self.options:
            generation["thinkingConfig"] = {
                "thinkingLevel": self.options["thinking_level"],
                "includeThoughts": False,
            }
        body = {
            "systemInstruction": {"parts": [{"text": request.instructions}]},
            "contents": [{"role": "user", "parts": [{"text": request.input_text}]}],
            "generationConfig": generation,
        }
        model = quote(request.model.removeprefix("models/"), safe="-._")
        async with self.response(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse",
            {"x-goog-api-key": self._api_key},
            body,
        ) as response:
            reason = None
            tool = False
            upstream = request_id(response.headers)
            effective_model = None
            async for event in events(response):
                data = object_data(event)
                if "error" in data:
                    raise provider_error(data, headers=response.headers)
                upstream = data.get("responseId") or upstream
                effective_model = data.get("modelVersion", effective_model)
                if (data.get("promptFeedback") or {}).get("blockReason"):
                    reason = "blocked"
                usage = data.get("usageMetadata")
                if usage is not None:
                    yield Usage(
                        tokens(usage.get("promptTokenCount")),
                        tokens(usage.get("candidatesTokenCount")),
                        tokens(usage.get("cachedContentTokenCount")),
                        tokens(usage.get("thoughtsTokenCount")),
                    )
                for candidate in data.get("candidates", []):
                    if candidate.get("index", 0) != 0:
                        continue
                    finish = candidate.get("finishReason")
                    blocked_frame = reason == "blocked" or finish in {
                        "SAFETY",
                        "RECITATION",
                        "BLOCKLIST",
                        "PROHIBITED_CONTENT",
                        "SPII",
                        "IMAGE_SAFETY",
                    }
                    for part in (candidate.get("content") or {}).get("parts", []):
                        tool = tool or any(
                            key in part
                            for key in ("functionCall", "executableCode", "codeExecutionResult")
                        )
                        if (
                            "text" in part
                            and not part.get("thought", False)
                            and not tool
                            and not blocked_frame
                        ):
                            if reason is not None:
                                raise ProviderError(
                                    "stream_interrupted",
                                    "Provider sent answer text after completion.",
                                )
                            if not isinstance(part["text"], str):
                                raise ProviderError(
                                    "stream_interrupted", "Provider text part is invalid."
                                )
                            if part["text"]:
                                yield TextDelta(part["text"])
                    if finish:
                        normalized = {
                            "STOP": "stop",
                            "MAX_TOKENS": "length",
                            "SAFETY": "blocked",
                            "RECITATION": "blocked",
                            "BLOCKLIST": "blocked",
                            "PROHIBITED_CONTENT": "blocked",
                            "SPII": "blocked",
                            "IMAGE_SAFETY": "blocked",
                        }.get(finish, "unknown")
                        if reason is not None and reason != normalized:
                            raise ProviderError(
                                "stream_interrupted",
                                "Provider sent contradictory completion metadata.",
                            )
                        reason = normalized
            if reason is None:
                raise ProviderError("stream_interrupted", "Provider omitted its finish reason.")
            yield Finished("tool_call" if tool else reason, upstream, effective_model, "gemini")
