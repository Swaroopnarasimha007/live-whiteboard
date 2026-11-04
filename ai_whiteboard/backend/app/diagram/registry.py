import asyncio

from app.config.settings import environment
from app.contracts.interfaces import ProviderError

from .capabilities import validate_profile
from .providers.anthropic import AnthropicDiagramProvider
from .providers.gemini import GeminiDiagramProvider
from .providers.groq import GroqDiagramProvider
from .providers.mock import MockDiagramProvider
from .providers.openai import OpenAIDiagramProvider
from .providers.openrouter import OpenRouterDiagramProvider

PROVIDERS = {
    "groq": GroqDiagramProvider,
    "openrouter": OpenRouterDiagramProvider,
    "openai": OpenAIDiagramProvider,
    "gemini": GeminiDiagramProvider,
    "anthropic": AnthropicDiagramProvider,
}


class DiagramRegistry:
    def __init__(self, settings, *, environ=None, client_factory=None):
        self.settings = settings.model_copy(deep=True)
        self.client_factory = client_factory
        self.clients = {}
        self.closed = False
        env = environment() if environ is None else environ
        self._keys = {
            name: env.get(profile.api_key_env or "", "")
            for name, profile in settings.diagram.profiles.items()
            if name in settings.diagram.enabled_profiles and profile.provider != "mock"
        }

    def availability(self, name):
        if self.closed:
            return False, "provider_unavailable"
        if name not in self.settings.diagram.enabled_profiles:
            return False, "profile_not_enabled"
        profile = self.settings.diagram.profiles[name]
        if profile.provider != "mock":
            if "REPLACE_WITH" in profile.model.upper():
                return False, "model_unavailable"
            if not self._keys.get(name):
                return False, "authentication_failed"
            if not profile.capabilities.verified:
                return False, "capabilities_not_verified"
        try:
            validate_profile(profile, self.settings.diagram.max_output_tokens)
        except ProviderError as exc:
            return False, exc.code
        return True, None

    def select_profile(self, requested=None):
        config = self.settings.diagram
        name = requested or config.active_profile
        if not config.allow_client_profile_selection and name != config.active_profile:
            raise ProviderError(
                "permission_denied", "Client diagram-profile selection is disabled."
            )
        ready, reason = self.availability(name)
        if not ready:
            code = (
                reason
                if reason
                in {"authentication_failed", "unsupported_parameter", "provider_unavailable"}
                else "model_unavailable"
            )
            raise ProviderError(
                code,
                "Diagram profile is unavailable. Check enabled profiles, exact model ID, credentials and verified capabilities; then restart.",
            )
        return name

    def get(self, name):
        # Only enabled, preflighted profiles can instantiate clients. No network calls at startup.
        ready, _ = self.availability(name)
        if not ready:
            raise ProviderError("model_unavailable", "Diagram profile is unavailable.")
        if name not in self.clients:
            profile = self.settings.diagram.profiles[name]
            if profile.provider == "mock":
                provider = MockDiagramProvider()
            else:
                provider = PROVIDERS[profile.provider](
                    api_key=self._keys[name],
                    capabilities=profile.capabilities.model_copy(deep=True),
                    options=dict(profile.options),
                    connect_timeout=self.settings.diagram.connect_timeout_seconds,
                    client=self.client_factory(name) if self.client_factory else None,
                )
            self.clients[name] = provider
        return self.clients[name]

    async def aclose(self):
        self.closed = True
        try:
            await asyncio.gather(
                *(client.aclose() for client in self.clients.values()), return_exceptions=True
            )
        finally:
            self.clients.clear()
            self._keys.clear()
