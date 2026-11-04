"""Frozen provider boundaries. Implementations belong to B1/B2; no SDK imports here."""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal, Protocol

from .audio import SpeechStreamConfig, TranscriptEvent


class SpeechStream(Protocol):
    async def push_audio(self, frame: bytes) -> None: ...
    def events(self) -> AsyncIterator[TranscriptEvent]: ...
    async def finish(self) -> None: ...
    async def close(self) -> None: ...


class Transcriber(Protocol):
    async def open_stream(self, config: SpeechStreamConfig) -> SpeechStream: ...


@dataclass(frozen=True)
class LLMRequest:
    request_id: str
    model: str
    instructions: str
    input_text: str
    max_output_tokens: int
    temperature: float | None = None


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class Usage:
    input_tokens: int | None
    output_tokens: int | None
    cached_input_tokens: int | None = None
    reasoning_tokens: int | None = None


@dataclass(frozen=True)
class Finished:
    reason: Literal["stop", "length", "blocked", "tool_call", "unknown"]
    provider_request_id: str | None = None
    effective_model: str | None = None
    effective_provider: str | None = None

    def __post_init__(self):
        for name in ("provider_request_id", "effective_model", "effective_provider"):
            value = getattr(self, name)
            object.__setattr__(
                self, name, value[:256] if isinstance(value, str) and value.isprintable() else None
            )


LLMEvent = TextDelta | Usage | Finished
ProviderErrorCode = Literal[
    "authentication_failed",
    "permission_denied",
    "model_unavailable",
    "unsupported_parameter",
    "rate_limited",
    "quota_exceeded",
    "context_too_large",
    "provider_timeout",
    "provider_unavailable",
    "stream_interrupted",
    "content_blocked",
    "output_limit",
    "invalid_output",
    "cancelled",
]


class ProviderError(Exception):
    """Message must be safe for the browser; never pass through raw upstream errors."""

    def __init__(
        self,
        code: ProviderErrorCode,
        message: str,
        *,
        retryable: bool = False,
        retry_after: float | None = None,
        upstream_request_id: str | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.retry_after = retry_after
        self.upstream_request_id = upstream_request_id


class DiagramProvider(Protocol):
    def stream(self, request: LLMRequest) -> AsyncIterator[LLMEvent]: ...
    async def aclose(self) -> None: ...
