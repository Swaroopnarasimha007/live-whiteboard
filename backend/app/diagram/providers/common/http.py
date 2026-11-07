import asyncio
import math
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import httpx

from app.contracts.interfaces import ProviderError, Usage
from app.diagnostics import diagnostic

MESSAGES = {
    "authentication_failed": "Provider credentials were rejected.",
    "permission_denied": "The provider denied access to this model.",
    "model_unavailable": "The configured provider model is unavailable.",
    "unsupported_parameter": "The provider rejected a configured parameter.",
    "rate_limited": "The provider rate limit was reached. Retry later with a new request.",
    "quota_exceeded": "The provider quota is exhausted.",
    "context_too_large": "The provider input exceeds the model context budget.",
    "provider_timeout": "The provider timed out.",
    "provider_unavailable": "The provider is temporarily unavailable.",
    "stream_interrupted": "The provider stream was interrupted.",
    "content_blocked": "The provider blocked this generation.",
}
ERROR_CODES = {
    "invalid_api_key": "authentication_failed",
    "authentication_error": "authentication_failed",
    "UNAUTHENTICATED": "authentication_failed",
    "permission_error": "permission_denied",
    "PERMISSION_DENIED": "permission_denied",
    "model_not_found": "model_unavailable",
    "NOT_FOUND": "model_unavailable",
    "unsupported_parameter": "unsupported_parameter",
    "invalid_request_error": "unsupported_parameter",
    "json_validate_failed": "invalid_output",
    "tool_use_failed": "invalid_output",
    "INVALID_ARGUMENT": "unsupported_parameter",
    "insufficient_quota": "quota_exceeded",
    "quota_exceeded": "quota_exceeded",
    "context_length_exceeded": "context_too_large",
    "request_too_large": "context_too_large",
    "rate_limit_error": "rate_limited",
    "rate_limit_exceeded": "rate_limited",
    "RESOURCE_EXHAUSTED": "rate_limited",
    "overloaded_error": "provider_unavailable",
    "api_error": "provider_unavailable",
    "UNAVAILABLE": "provider_unavailable",
    "content_filter": "content_blocked",
    "content_policy_violation": "content_blocked",
}


def request_id(headers):
    value = (
        headers.get("x-request-id") or headers.get("request-id") or headers.get("x-goog-request-id")
    )
    return value[:128] if value and value.isprintable() else None


def retry_after(value):
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        try:
            seconds = (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
        except (TypeError, ValueError, OverflowError):
            return None
    return max(0, seconds) if math.isfinite(seconds) else None


def provider_error(data, *, status=None, headers=None):
    error = data.get("error", data) if isinstance(data, dict) else {}
    if not isinstance(error, dict):
        error = {}
    # Classify upstream explanations without copying prompts or failed generations.
    message = error.get("message")
    message = message.lower() if isinstance(message, str) else ""
    reason = next(
        (
            category
            for phrase, category in (
                ("failed to generate json", "json_generation_failed"),
                ("does not match the expected schema", "schema_validation_failed"),
                ("invalid schema", "invalid_schema"),
                ("not supported", "unsupported_option"),
                ("context length", "context_limit"),
            )
            if phrase in message
        ),
        "unclassified",
    )
    diagnostic(
        "provider.error_detail",
        warning=True,
        status=status,
        reason=reason,
        schema_keywords=[
            keyword
            for keyword in (
                "anyOf",
                "oneOf",
                "$ref",
                "$defs",
                "additionalProperties",
                "required",
                "properties",
                "type",
                "minProperties",
                "placement",
            )
            if keyword.lower() in message
        ],
        upstream_request_id=request_id(headers) if headers else None,
        provider_code=error.get("code")
        if isinstance(error.get("code"), str) and error.get("code") in ERROR_CODES
        else "unrecognized",
        provider_type=error.get("type")
        if isinstance(error.get("type"), str) and error.get("type") in ERROR_CODES
        else "unrecognized",
        parameter=error.get("param")
        if error.get("param")
        in (
            "response_format",
            "temperature",
            "reasoning_effort",
            "include_reasoning",
            "max_tokens",
            "max_completion_tokens",
            "stream",
            "tools",
            "tool_choice",
        )
        else None,
    )
    default = {
        400: "unsupported_parameter",
        401: "authentication_failed",
        402: "quota_exceeded",
        403: "permission_denied",
        404: "model_unavailable",
        408: "provider_timeout",
        413: "context_too_large",
        422: "unsupported_parameter",
        429: "rate_limited",
    }.get(status, "provider_unavailable")
    code = next(
        (
            ERROR_CODES[value]
            for key in ("code", "type", "status")
            if isinstance((value := error.get(key)), str) and value in ERROR_CODES
        ),
        default,
    )
    return ProviderError(
        code,
        MESSAGES.get(code, "Provider generation failed output validation."),
        retryable=code
        in ("rate_limited", "provider_timeout", "provider_unavailable", "stream_interrupted"),
        retry_after=retry_after(headers.get("retry-after")) if headers else None,
        upstream_request_id=request_id(headers) if headers else None,
    )


def tokens(value):
    return value if type(value) is int and value >= 0 else None


def merge_usage(previous: Usage, current: Usage) -> Usage:
    return Usage(
        **{
            key: getattr(current, key)
            if getattr(current, key) is not None
            else getattr(previous, key)
            for key in ("input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens")
        }
    )


def chat_usage(value):
    return Usage(
        tokens(value.get("prompt_tokens")),
        tokens(value.get("completion_tokens")),
        tokens((value.get("prompt_tokens_details") or {}).get("cached_tokens")),
        tokens((value.get("completion_tokens_details") or {}).get("reasoning_tokens")),
    )


class HTTPProvider:
    def __init__(
        self, *, api_key: str, capabilities, options=None, client=None, connect_timeout=10
    ):
        self._api_key = api_key
        self.capabilities = capabilities
        self.options = options or {}
        self._owns_client = client is None
        self.client = client or httpx.AsyncClient(
            transport=httpx.AsyncHTTPTransport(retries=0),
            timeout=httpx.Timeout(
                connect=connect_timeout, read=None, write=connect_timeout, pool=connect_timeout
            ),
            follow_redirects=False,
            trust_env=False,
        )

    @asynccontextmanager
    async def response(self, url, headers, body):
        upstream = None
        try:
            async with self.client.stream(
                "POST", url, headers={**headers, "Accept": "text/event-stream"}, json=body
            ) as response:
                upstream = request_id(response.headers)
                diagnostic(
                    "provider.http_response",
                    warning=response.status_code != 200,
                    status=response.status_code,
                    upstream_request_id=upstream,
                    content_type=response.headers.get("content-type", "").split(";")[0],
                )
                if response.status_code != 200:
                    payload = bytearray()
                    async for chunk in response.aiter_bytes():
                        payload.extend(chunk[: 8192 - len(payload)])
                        if len(payload) >= 8192:
                            break
                    import json

                    try:
                        data = json.loads(payload)
                    except (ValueError, UnicodeDecodeError):
                        data = {}
                    raise provider_error(
                        data, status=response.status_code, headers=response.headers
                    )
                if response.headers.get("content-type", "").split(";")[0].strip().lower() != (
                    "text/event-stream" if body.get("stream", True) else "application/json"
                ):
                    raise ProviderError(
                        "stream_interrupted", "Provider did not return an SSE stream."
                    )
                yield response
        except ProviderError as exc:
            exc.upstream_request_id = exc.upstream_request_id or upstream
            raise
        except httpx.TimeoutException:
            raise ProviderError(
                "provider_timeout",
                MESSAGES["provider_timeout"],
                retryable=True,
                upstream_request_id=upstream,
            ) from None
        except httpx.HTTPError:
            raise ProviderError(
                "stream_interrupted",
                MESSAGES["stream_interrupted"],
                retryable=True,
                upstream_request_id=upstream,
            ) from None
        except (KeyError, IndexError, TypeError, AttributeError, ValueError, RecursionError):
            raise ProviderError(
                "stream_interrupted",
                "Provider event does not match its protocol.",
                upstream_request_id=upstream,
            ) from None

    async def aclose(self):
        if self._owns_client:
            await self.client.aclose()

    def temperature(self, request, body):
        if request.temperature is not None:
            if not self.capabilities.temperature_support:
                raise ProviderError(
                    "unsupported_parameter", "This profile does not support temperature."
                )
            body["temperature"] = request.temperature


async def close_iterator(iterator):
    close = getattr(iterator, "aclose", None)
    if close is not None:
        await asyncio.wait_for(close(), timeout=1)
