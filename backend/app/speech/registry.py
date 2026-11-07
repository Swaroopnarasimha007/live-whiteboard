import asyncio

from app.diagnostics import diagnostic
from app.contracts.audio import SpeechStreamConfig

from .errors import SpeechError
from .mock import FIXTURES, mock_engine
from .models import ModelCache, load_whisper_model, model_valid, whisper_installed
from .stream import WorkerSpeechStream
from .whisper import WhisperEngine


class SpeechRegistry:
    """Explicit allowlist; configuration and provider choice are pinned at construction."""

    def __init__(self, settings, *, model_loader=None, engine_factory=None):
        self.settings = settings.model_copy(deep=True)

        def loader(path):
            profile = next(
                p
                for name, p in self.settings.transcription.profiles.items()
                if p.provider == "whisper" and self.settings.model_path(name) == path
            )
            return load_whisper_model(
                path, device=profile.device, compute_type=profile.compute_type
            )

        options = {"loader": model_loader or loader}
        self.cache = ModelCache(settings.transcription.model_cache.max_loaded_models, **options)
        self.engine_factory = engine_factory
        self.streams = set()
        self.opening = set()
        self.active = 0
        self.closed = False
        self.lock = asyncio.Lock()

    async def preload(self):
        name = self.settings.transcription.default_profile
        if self.settings.transcription.profiles[name].provider == "whisper":
            # First run may have no local model yet. Install it before profile
            # availability checks so a fresh clone can start with `python -m app`.
            from scripts.models.ensure import ensure_models

            try:
                await asyncio.to_thread(ensure_models, self.settings)
            except Exception as error:
                # Speech is optional for the board itself. Keep the API usable if
                # model setup fails, and expose the unavailable profile in capabilities.
                diagnostic(
                    "speech.model_setup_failed",
                    warning=True,
                    profile=name,
                    error_type=type(error).__name__,
                    reason=str(error),
                )
                return
            available, reason = self.availability(name)
            if not available:
                diagnostic(
                    "speech.profile_unavailable", warning=True, profile=name, reason=reason
                )
                return
            path = self.settings.model_path(name)
            try:
                self.select_profile(name)
                await self.cache.acquire(path)
                await self.cache.release(path)
            except SpeechError as error:
                diagnostic(
                    "speech.model_load_failed",
                    warning=True,
                    profile=name,
                    reason=error.code,
                )

    def availability(self, profile):
        config = self.settings.transcription
        if profile not in config.enabled_profiles:
            return False, "profile_not_enabled"
        p = config.profiles[profile]
        if p.provider == "mock":
            return (True, None) if p.fixture in FIXTURES else (False, "fixture_unavailable")
        if not model_valid(self.settings.model_path(profile)):
            return False, "model_not_installed"
        if not whisper_installed() and self.engine_factory is None:
            return False, "provider_not_installed"
        return True, None

    def select_profile(self, requested=None):
        config = self.settings.transcription
        selected = requested or config.default_profile
        if not config.allow_client_profile_selection and selected != config.default_profile:
            raise SpeechError(
                "profile_selection_disabled", "Use the backend's default speech profile."
            )
        ready, reason = self.availability(selected)
        if not ready:
            raise SpeechError(
                reason,
                "Speech profile is unavailable. Enable it and install its model/provider before capture.",
            )
        return selected

    async def open_stream(self, config: SpeechStreamConfig):
        if len(config.streamId) > 48:
            raise SpeechError("invalid_stream_id", "Audio stream ID must be at most 48 characters.")
        self.select_profile(config.profile)
        async with self.lock:
            if self.closed:
                raise SpeechError("closed", "Speech registry is closed.")
            if self.active >= self.settings.transcription.model_cache.max_active_recognizers:
                raise SpeechError(
                    "overloaded", "All speech recognizers are busy. Stop another capture and retry."
                )
            self.active += 1
            self.opening.add(asyncio.current_task())
        path = self.settings.model_path(config.profile)
        stream = None
        acquired = False
        try:
            profile = self.settings.transcription.profiles[config.profile]
            model = None
            if profile.provider == "whisper":
                model = await self.cache.acquire(path)
                acquired = True

            def factory():
                if self.engine_factory:
                    return self.engine_factory(config, model)
                return (
                    mock_engine(config, profile.fixture)
                    if profile.provider == "mock"
                    else WhisperEngine(
                        config,
                        model,
                        profile.language,
                        self.settings.transcription.endpointing,
                        progress=lambda stage: stream.progress(stage),
                    )
                )

            async def release(stream):
                if acquired:
                    await self.cache.release(path)
                async with self.lock:
                    self.active -= 1
                    self.streams.discard(stream)

            stream = WorkerSpeechStream(
                config, factory, release, self.settings.sessions.max_pending_events
            )
            async with self.lock:
                self.streams.add(stream)
                if self.closed:
                    raise SpeechError("closed", "Speech registry is closed.")
            await stream.initialize()
            if self.closed or stream.aborted:
                raise SpeechError("closed", "Speech registry closed while starting capture.")
            return stream
        except BaseException:
            if stream is not None:
                await stream.close()
            else:
                if acquired:
                    await self.cache.release(path)
                async with self.lock:
                    self.active -= 1
            raise
        finally:
            self.opening.discard(asyncio.current_task())

    async def aclose(self):
        async with self.lock:
            self.closed = True
            streams = list(self.streams)
            opening = list(self.opening)
        for task in opening:
            task.cancel()
        await asyncio.gather(*opening, return_exceptions=True)
        await asyncio.gather(*(stream.close() for stream in streams))
        await asyncio.gather(*(stream.wait_closed() for stream in streams))
        await self.cache.aclose()
