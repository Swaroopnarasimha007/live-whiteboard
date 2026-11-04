"""Optional credentialed checks. Never spend credits merely because a key happens to exist."""

import asyncio
import os

import pytest

from app.config import load_settings
from app.diagram import CompletedResult, DiagramRegistry, GenerationService, GenerationState

from .test_generation import request


@pytest.mark.parametrize("provider", ["groq", "openrouter", "openai", "gemini", "anthropic"])
def test_opt_in_live_provider(provider, record_property):
    if os.environ.get("WHITEBOARD_LIVE_LLM_TESTS") != "1":
        pytest.skip(f"{provider}: credentialed API smoke is opt-in (WHITEBOARD_LIVE_LLM_TESTS=1)")
    settings = load_settings()
    name = next(
        (
            name
            for name in settings.diagram.enabled_profiles
            if settings.diagram.profiles[name].provider == provider
        ),
        None,
    )
    if name is None:
        pytest.skip(f"{provider}: no enabled configured profile")
    settings.diagram.active_profile = name
    registry = DiagramRegistry(settings)
    ready, reason = registry.availability(name)
    if not ready:
        pytest.skip(f"{provider}: unavailable ({reason})")
    record_property("provider", provider)
    record_property("model", settings.diagram.profiles[name].model)

    async def run():
        try:
            service = GenerationService(registry)
            state = GenerationState()
            events = [
                event async for event in service.generate(service.prepare(request()), state=state)
            ]
            assert isinstance(events[-1], CompletedResult), events[-1]
            record_property("operation_count", state.operation_count)
            record_property("first_operation_seconds", state.first_operation_seconds)
        finally:
            await registry.aclose()

    asyncio.run(run())
