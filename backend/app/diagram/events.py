from dataclasses import dataclass, field

from app.contracts.interfaces import Usage
from app.contracts.operations import Operation


@dataclass(frozen=True)
class OperationResult:
    operation: Operation


@dataclass(frozen=True)
class WarningResult:
    code: str
    message: str
    line: int | None = None


@dataclass
class GenerationState:
    operation_count: int = 0
    warning_count: int = 0
    usage: Usage = field(default_factory=lambda: Usage(None, None))
    profile: str = ""
    provider: str = ""
    model: str = ""
    configuration_fingerprint: str = ""
    upstream_request_id: str | None = None
    effective_provider: str | None = None
    effective_model: str | None = None
    first_text_seconds: float | None = None
    first_operation_seconds: float | None = None
    elapsed_seconds: float = 0
    local_stream_closed: bool = False
    upstream_cancellation: str = "unknown"


@dataclass(frozen=True)
class CompletedResult:
    operation_count: int
    warning_count: int


@dataclass(frozen=True)
class FailedResult:
    code: str
    message: str
    retryable: bool = False
    retry_after: float | None = None


GenerationResult = OperationResult | WarningResult | CompletedResult | FailedResult
