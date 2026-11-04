import math
import re

from app.contracts.interfaces import ProviderError

TOKEN_PARAMETERS = {
    "groq": {"max_tokens", "max_completion_tokens"},
    "openrouter": {"max_tokens"},
    "openai": {"max_output_tokens"},
    "gemini": {"maxOutputTokens"},
    "anthropic": {"max_tokens"},
}
OPTIONS = {
    "groq": {"temperature", "reasoning_effort", "reasoning_format", "include_reasoning"},
    "openrouter": {"temperature", "reasoning_effort", "provider"},
    "openai": {"temperature", "reasoning_effort"},
    "gemini": {"temperature", "thinking_budget", "thinking_level"},
    "anthropic": {"temperature", "thinking_budget"},
}


def unsupported():
    raise ProviderError(
        "unsupported_parameter",
        "Profile options/capabilities are incompatible with this provider or model budget.",
    )


def validate_profile(profile, max_output):
    if profile.provider == "mock":
        if profile.model not in {
            "request-flow",
            "delayed",
            "fragmented",
            "invalid",
            "error",
            "no-op",
        }:
            unsupported()
        return
    caps = profile.capabilities
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/@+\-]{0,255}", profile.model):
        unsupported()
    if (profile.provider == "groq" and "compound" in profile.model.lower()) or (
        profile.provider == "openrouter" and profile.model.endswith(":online")
    ):
        unsupported()  # These model families can enable hosted tools outside the text-only contract.
    if (
        (not caps.text_streaming and not caps.structured_output)
        or caps.token_limit_parameter not in TOKEN_PARAMETERS[profile.provider]
        or max_output > caps.output_limit
        or max_output >= caps.context_limit
        or set(profile.options) - OPTIONS[profile.provider]
    ):
        unsupported()
    if caps.structured_output and profile.provider not in ("groq", "openrouter"):
        unsupported()
    if caps.structured_output_streaming and (
        not caps.structured_output or profile.provider == "groq"
    ):
        unsupported()
    temperature = profile.options.get("temperature")
    if "temperature" in profile.options and (
        not caps.temperature_support
        or type(temperature) not in (float, int)
        or not math.isfinite(temperature)
        or temperature < 0
        or temperature > (1 if profile.provider == "anthropic" else 2)
    ):
        unsupported()
    for key in (
        "reasoning_effort",
        "thinking_budget",
        "thinking_level",
        "reasoning_format",
        "include_reasoning",
    ):
        if key in profile.options and key not in caps.reasoning_controls:
            unsupported()
    if "reasoning_effort" in profile.options and (
        not isinstance(profile.options["reasoning_effort"], str)
        or profile.options["reasoning_effort"]
        not in {
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            *(("default",) if profile.provider == "groq" else ()),
        }
    ):
        unsupported()
    if profile.provider == "groq":
        if "reasoning_effort" in profile.options and not {
            "reasoning_format",
            "include_reasoning",
        }.intersection(caps.reasoning_controls):
            unsupported()
        if "reasoning_format" in profile.options and profile.options["reasoning_format"] not in (
            "hidden",
            "parsed",
        ):
            unsupported()
        if (
            "include_reasoning" in profile.options
            and profile.options["include_reasoning"] is not False
        ):
            unsupported()
        if "reasoning_format" in profile.options and "include_reasoning" in profile.options:
            unsupported()
    if "thinking_budget" in profile.options:
        value = profile.options["thinking_budget"]
        minimum = 1024 if profile.provider == "anthropic" else -1
        if type(value) is not int or value < minimum or value >= max_output:
            unsupported()
        if profile.provider == "anthropic" and temperature not in (None, 1):
            unsupported()
    if "thinking_level" in profile.options and (
        not isinstance(profile.options["thinking_level"], str)
        or profile.options["thinking_level"] not in {"MINIMAL", "LOW", "MEDIUM", "HIGH"}
        or "thinking_budget" in profile.options
    ):
        unsupported()
    if "provider" in profile.options:
        routing = profile.options["provider"]
        if not isinstance(routing, dict) or set(routing) - {
            "order",
            "allow_fallbacks",
            "require_parameters",
        }:
            unsupported()
        if (
            routing.get("allow_fallbacks", False) is not False
            or routing.get("require_parameters", True) is not True
        ):
            unsupported()
        if "order" in routing and (
            not isinstance(routing["order"], list)
            or not routing["order"]
            or any(
                not isinstance(host, str) or not host.strip() or len(host) > 128
                for host in routing["order"]
            )
        ):
            unsupported()
