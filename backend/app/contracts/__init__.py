"""Public B0 contracts. Use these types rather than component-local wire models."""

from .api import ErrorDetail, ErrorResponse, SessionCreate, SessionCreated, SessionOwner
from .audio import AudioFormat, AudioStart, SpeechStreamConfig, TranscriptEvent
from .generation import GenerationEvent, GenerationRequest, generation_event_adapter
from .interfaces import (
    DiagramProvider,
    Finished,
    LLMEvent,
    LLMRequest,
    ProviderError,
    SpeechStream,
    TextDelta,
    Transcriber,
    Usage,
)
from .operations import Operation, operation_adapter

__all__ = [
    "AudioFormat",
    "AudioStart",
    "DiagramProvider",
    "ErrorDetail",
    "ErrorResponse",
    "Finished",
    "GenerationEvent",
    "GenerationRequest",
    "LLMEvent",
    "LLMRequest",
    "Operation",
    "ProviderError",
    "SessionCreate",
    "SessionCreated",
    "SessionOwner",
    "SpeechStream",
    "SpeechStreamConfig",
    "TextDelta",
    "Transcriber",
    "TranscriptEvent",
    "Usage",
    "generation_event_adapter",
    "operation_adapter",
]
