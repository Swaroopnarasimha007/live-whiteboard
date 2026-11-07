import asyncio
import json

import pytest

from app.config import Settings
from app.config.settings import DiagramProfile, ModelCapabilities
from app.contracts.interfaces import Finished, ProviderError, Usage
from app.diagram import (
    CompletedResult,
    DiagramRegistry,
    GenerationService,
    GenerationState,
    OperationResult,
)
from app.diagram.capabilities import validate_profile

from .test_generation import request
from .test_providers import NAMES, PARAMETERS, TEXT, adapter, frames


def profile(name, **options):
    return DiagramProfile(
        provider=name,
        model="test-model",
        api_key_env="TEST_KEY",
        options=options,
        capabilities=ModelCapabilities(
            verified=True,
            context_limit=32768,
            output_limit=4096,
            token_limit_parameter=PARAMETERS[name],
            temperature_support=True,
            reasoning_controls=["reasoning_effort", "thinking_budget", "thinking_level"],
        ),
    )


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize(
    "options",
    [
        {"arbitrary": True},
        {"tools": []},
        {"temperature": True},
        {"temperature": -1},
        {"temperature": float("nan")},
    ],
)
def test_unknown_and_invalid_controls_are_rejected(name, options):
    with pytest.raises(ProviderError) as caught:
        validate_profile(profile(name, **options), 2048)
    assert caught.value.code == "unsupported_parameter"


@pytest.mark.parametrize("name", NAMES)
def test_profile_token_mapping_and_request_body_are_explicit(name):
    async def run():
        p = profile(name)
        validate_profile(p, 2048)
        async with adapter(name, frames(name)) as (provider, _, requests, _):
            from dataclasses import replace

            from .test_providers import llm

            _ = [event async for event in provider.stream(replace(llm(), temperature=0.5))]
            body = json.loads(requests[0].content)
            if name == "gemini":
                assert body["generationConfig"]["maxOutputTokens"] == 128
                assert body["generationConfig"]["temperature"] == 0.5
                assert body["systemInstruction"]["parts"][0]["text"] == "instructions"
                assert body["contents"][0]["parts"][0]["text"] == "user context"
            else:
                assert body[PARAMETERS[name]] == 128
                assert body["temperature"] == 0.5 and body["tools"] == []
            if name in ("groq", "openrouter"):
                assert body["n"] == 1 and body["tool_choice"] == "none"
            if name == "openrouter":
                assert body["provider"] == {"allow_fallbacks": False, "require_parameters": True}
            if name == "openai":
                assert (
                    body["input"] == "user context"
                    and body["instructions"] == "instructions"
                    and body["store"] is False
                )
            if name == "anthropic":
                assert (
                    requests[0].headers["anthropic-version"] == "2023-06-01"
                    and body["system"] == "instructions"
                )
        p.capabilities.token_limit_parameter = (
            "maxOutputTokens" if name != "gemini" else "max_tokens"
        )
        with pytest.raises(ProviderError):
            validate_profile(p, 2048)

    asyncio.run(run())


@pytest.mark.parametrize("name", NAMES)
def test_same_operation_reaches_generation_service_before_provider_completion(name):
    async def run():
        async with adapter(name, frames(name, texts=(TEXT,))) as (provider, streams, _, _):
            settings = Settings()
            settings.diagram.profiles["live"] = profile(name)
            settings.diagram.active_profile = "live"
            settings.diagram.enabled_profiles.append("live")
            registry = DiagramRegistry(settings, environ={"TEST_KEY": "FAKE_SECRET"})
            registry.clients["live"] = provider
            service = GenerationService(registry)
            state = GenerationState()
            iterator = service.generate(service.prepare(request()), state=state)
            first = await anext(iterator)
            assert isinstance(first, OperationResult) and first.operation.title == "café 日本語"
            assert not streams[0].closed and state.first_operation_seconds is not None
            tail = [event async for event in iterator]
            assert tail == [CompletedResult(1, 0)] and state.usage == Usage(10, 2)
            assert state.local_stream_closed
            await registry.aclose()

    asyncio.run(run())


def test_reasoning_and_routing_controls_reject_incompatible_values():
    for name, options in [
        ("groq", {"reasoning_effort": {"bad": 1}}),
        ("openai", {"reasoning_effort": "invented"}),
        ("openrouter", {"provider": {"allow_fallbacks": True}}),
        ("openrouter", {"provider": {"base_url": "https://arbitrary.example"}}),
        ("gemini", {"thinking_level": "HIGH", "thinking_budget": 100}),
        ("anthropic", {"thinking_budget": 100}),
        ("anthropic", {"thinking_budget": 1024, "temperature": 0.5}),
    ]:
        with pytest.raises(ProviderError):
            validate_profile(profile(name, **options), 2048)
    for name, model in [("groq", "groq/compound"), ("openrouter", "vendor/model:online")]:
        p = profile(name)
        p.model = model
        with pytest.raises(ProviderError):
            validate_profile(p, 2048)
    metadata = Finished("stop", {"not": "a request ID"}, "test-model", "host")
    assert metadata.provider_request_id is None


@pytest.mark.parametrize("name", NAMES)
def test_idle_answer_timeout_preserves_first_operation_and_closes_http_stream(name):
    async def run():
        raw = frames(name, texts=(TEXT,), terminal=False) + [0.5]
        async with adapter(name, raw) as (provider, streams, _, _):
            settings = Settings()
            settings.diagram.first_text_timeout_seconds = 0.2
            settings.diagram.idle_text_timeout_seconds = 0.1
            settings.diagram.profiles["live"] = profile(name)
            settings.diagram.active_profile = "live"
            settings.diagram.enabled_profiles.append("live")
            registry = DiagramRegistry(settings, environ={"TEST_KEY": "FAKE_SECRET"})
            registry.clients["live"] = provider
            service = GenerationService(registry)
            state = GenerationState()
            result = [e async for e in service.generate(service.prepare(request()), state=state)]
            assert isinstance(result[0], OperationResult)
            assert result[-1].code == "provider_timeout" and state.operation_count == 1
            assert streams[0].closed and state.local_stream_closed
            await registry.aclose()

    asyncio.run(run())


def test_groq_reasoning_output_mode_is_explicit_and_verified():
    async def run():
        async with adapter("groq", frames("groq")) as (provider, _, requests, _):
            provider.capabilities.reasoning_controls = ["include_reasoning", "reasoning_format"]
            provider.options = {"include_reasoning": False}
            from .test_providers import llm

            _ = [event async for event in provider.stream(llm())]
            body = json.loads(requests[0].content)
            assert body["include_reasoning"] is False and "reasoning_format" not in body
            provider.options = {}
            _ = [event async for event in provider.stream(llm())]
            assert json.loads(requests[1].content)["reasoning_format"] == "hidden"
        p = profile("groq", reasoning_format="raw")
        p.capabilities.reasoning_controls.append("reasoning_format")
        with pytest.raises(ProviderError):
            validate_profile(p, 2048)
        p.options = {"reasoning_format": "parsed"}
        validate_profile(p, 2048)

    asyncio.run(run())
