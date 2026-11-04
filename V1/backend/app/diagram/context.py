import json

from pydantic import ValidationError

from app.contracts.generation import GenerationRequest
from app.contracts.interfaces import ProviderError


def validate_context(value, settings):
    try:
        data = value.model_dump() if isinstance(value, GenerationRequest) else value
        encoded = json.dumps(
            data, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        if len(encoded) > settings.server.max_request_bytes:
            raise ProviderError(
                "context_too_large", "Whole request exceeds the configured byte budget."
            )
        request = GenerationRequest.model_validate_json(encoded)
        board_bytes = len(
            json.dumps(
                request.board.model_dump(), ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
        )
        if board_bytes > settings.diagram.max_context_bytes:
            raise ProviderError(
                "context_too_large",
                "Full board context exceeds the configured byte budget. Retain text and reduce the board.",
            )
        return request
    except (ValidationError, TypeError, ValueError, OverflowError):
        raise ProviderError(
            "invalid_output",
            "Generation request does not match the complete board-context contract.",
        ) from None


def enforce_token_budget(request, profile):
    if profile.provider == "mock":
        return
    # Explicit conservative admission policy, not an exact tokenizer or billing count.
    # Verified profiles must accommodate byte-level text plus a 1024-token envelope reserve.
    upper_bound = (
        len(request.instructions.encode("utf-8")) + len(request.input_text.encode("utf-8")) + 1024
    )
    if upper_bound + request.max_output_tokens > profile.capabilities.context_limit:
        raise ProviderError(
            "context_too_large",
            "Input exceeds this profile's conservative token budget. Retain text and reduce the board or configure a verified larger context limit.",
        )
