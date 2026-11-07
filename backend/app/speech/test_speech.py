import asyncio
import itertools
import threading
import time

import pytest

from app.config import Settings
from app.contracts.audio import SpeechStreamConfig
from app.speech import SpeechError, SpeechRegistry
from app.speech.mock import mock_engine
from app.speech.models import ModelCache, model_valid, whisper_installed


def config(stream="audio1", profile="mock", **kwargs):
    return SpeechStreamConfig(streamId=stream, sessionEpoch=1, profile=profile, **kwargs)


def test_mock_revisions_sample_timing_and_isolated_streams():
    async def run():
        registry = SpeechRegistry(Settings())
        a = await registry.open_stream(config())
        b = await registry.open_stream(config("audio2"))

        async def collect(stream):
            return [e async for e in stream.events()]

        collect_a = asyncio.create_task(collect(a))
        collect_b = asyncio.create_task(collect(b))
        for _ in range(12):
            await a.push_audio(bytes(3200))
        for _ in range(3):
            await b.push_audio(bytes(3200))
        await a.finish()
        await a.finish()
        await b.finish()
        aa, bb = await collect_a, await collect_b
        finals = [e for e in aa if e.isFinal]
        assert finals[0].text == "the browser sends a request"
        assert finals[0].startMs == 0 and finals[0].endMs == 1000
        assert aa[0].id == finals[0].id and not aa[0].isFinal
        assert len({e.id for e in finals}) == len(finals)
        partials = [e for e in aa if not e.isFinal]
        assert all(y.endMs - x.endMs >= 150 for x, y in itertools.pairwise(partials))
        assert bb[-1].isFinal and bb[-1].endMs == 300
        assert all(e.streamId == "audio2" and e.sessionEpoch == 1 for e in bb)
        await a.close()
        await a.close()
        await registry.aclose()
        assert registry.active == 0

    asyncio.run(run())


def test_continuous_speech_and_abort():
    async def run():
        settings = Settings()
        settings.transcription.profiles["mock"].fixture = "continuous"
        registry = SpeechRegistry(settings)
        stream = await registry.open_stream(config(maxSegmentMs=400))
        for _ in range(10):
            await stream.push_audio(bytes(3200))
        await stream.finish()
        events = [e async for e in stream.events()]
        assert [e.endMs for e in events if e.isFinal] == [400, 800, 1000]
        assert len({e.id for e in events if e.isFinal}) == 3
        stream2 = await registry.open_stream(config("aborted"))
        await stream2.push_audio(bytes(6400))
        await stream2.close()
        await stream2.finish()
        assert [e async for e in stream2.events()] == []
        with pytest.raises(SpeechError, match="no longer"):
            await stream2.push_audio(bytes(3200))
        await registry.aclose()

    asyncio.run(run())


def test_limits_profile_policy_errors_and_one_consumer():
    async def run():
        settings = Settings()
        settings.transcription.allow_client_profile_selection = False
        registry = SpeechRegistry(settings)
        with pytest.raises(SpeechError) as error:
            registry.select_profile("whisper-small")
        assert error.value.code == "profile_selection_disabled"
        with pytest.raises(SpeechError):
            registry.select_profile("not-allowlisted")
        stream = await registry.open_stream(config())
        other = await registry.open_stream(config("other"))
        with pytest.raises(SpeechError) as error:
            await registry.open_stream(config("third"))
        assert error.value.code == "overloaded"
        iterator = stream.events()
        read = asyncio.create_task(anext(iterator))
        await asyncio.sleep(0)
        with pytest.raises(SpeechError) as error:
            await anext(stream.events())
        assert error.value.code == "consumer_conflict"
        for frame in (b"", b"x", bytes(32002)):
            with pytest.raises(SpeechError) as error:
                await stream.push_audio(frame)
            assert error.value.code == "invalid_audio"
        await stream.close()
        with pytest.raises(StopAsyncIteration):
            await read
        await other.close()
        await registry.aclose()

    asyncio.run(run())


def test_mock_failure_and_event_overload_are_explicit():
    async def run():
        settings = Settings()
        settings.transcription.profiles["mock"].fixture = "error"
        registry = SpeechRegistry(settings)
        stream = await registry.open_stream(config())
        with pytest.raises(SpeechError) as error:
            await stream.push_audio(bytes(9600))
        assert error.value.code == "recognition_failed"
        await registry.aclose()
        settings.transcription.profiles["mock"].fixture = "request-flow"
        settings.sessions.max_pending_events = 1
        registry = SpeechRegistry(settings)
        stream = await registry.open_stream(config())
        await stream.push_audio(bytes(6400))
        with pytest.raises(SpeechError) as error:
            await stream.push_audio(bytes(6400))
        assert error.value.code == "overloaded"
        await registry.aclose()

    asyncio.run(run())


def test_finish_drains_audio_already_waiting_for_the_ordered_worker():
    async def run():
        registry = SpeechRegistry(Settings())
        stream = await registry.open_stream(config())
        first = asyncio.create_task(stream.push_audio(bytes(3200)))
        second = asyncio.create_task(stream.push_audio(bytes(3200)))
        finish = asyncio.create_task(stream.finish())
        await asyncio.gather(first, second, finish)
        events = [event async for event in stream.events()]
        assert events[-1].isFinal and events[-1].endMs == 200
        await registry.aclose()

    asyncio.run(run())


def test_shutdown_during_native_initialization_releases_slot_after_return():
    async def run():
        entered, release = threading.Event(), threading.Event()

        def factory(cfg, model):
            entered.set()
            assert release.wait(3)
            return mock_engine(cfg, "request-flow")

        registry = SpeechRegistry(Settings(), engine_factory=factory)
        opening = asyncio.create_task(registry.open_stream(config()))
        while not entered.is_set():
            await asyncio.sleep(0.001)
        closing = asyncio.create_task(registry.aclose())
        await asyncio.sleep(0)
        assert registry.active == 1
        release.set()
        await closing
        assert opening.cancelled() and registry.active == 0 and not registry.streams

    asyncio.run(run())


def test_optional_model_unavailability_does_not_disable_mock(tmp_path, monkeypatch):
    import app.speech.registry as registry_module

    settings = Settings()
    registry = SpeechRegistry(settings)
    settings.transcription.profiles["whisper-small"].model_path = str(tmp_path / "missing")
    registry = SpeechRegistry(settings)
    assert registry.availability("whisper-small") == (False, "model_not_installed")
    assert registry.availability("mock") == (True, None)
    for part in ("am", "conf", "graph"):
        (tmp_path / part).mkdir()
    (tmp_path / "model.bin").touch()
    (tmp_path / "config.json").touch()
    (tmp_path / "tokenizer.json").touch()
    settings.transcription.profiles["whisper-small"].model_path = str(tmp_path)
    monkeypatch.setattr(registry_module, "whisper_installed", lambda: False)
    registry = SpeechRegistry(settings)
    assert registry.availability("whisper-small") == (False, "provider_not_installed")

    async def run():
        stream = await registry.open_stream(config())
        await stream.finish()
        await registry.aclose()

    asyncio.run(run())


def test_ordered_worker_does_not_block_loop_and_cancel_discards_late_events():
    async def run():
        entered, release = threading.Event(), threading.Event()
        calls = []

        class SlowEngine:
            def __init__(self, config):
                self.inner = mock_engine(config, "request-flow")

            def push(self, frame):
                calls.append(threading.get_ident())
                entered.set()
                assert release.wait(3)
                return self.inner.push(frame)

            def close(self):
                calls.append(threading.get_ident())
                self.inner.close()

        registry = SpeechRegistry(Settings(), engine_factory=lambda cfg, model: SlowEngine(cfg))
        stream = await registry.open_stream(config(maxBufferMs=100))
        task = asyncio.create_task(stream.push_audio(bytes(3200)))
        while not entered.is_set():
            await asyncio.sleep(0.001)
        assert calls[0] != threading.get_ident()
        with pytest.raises(SpeechError) as error:
            await stream.push_audio(bytes(3200))
        assert error.value.code == "overloaded"
        task.cancel()
        await stream.close()
        assert registry.active == 1  # Native call still owns the recognizer slot.
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        await stream.wait_closed()
        assert calls[0] == calls[-1]
        assert [e async for e in stream.events()] == []
        assert registry.active == 0
        await registry.aclose()

    asyncio.run(run())


def test_cache_deduplicates_loads_and_never_evicts_leased_models(tmp_path):
    async def run():
        loads = []

        def loader(path):
            loads.append(path)
            time.sleep(0.02)
            return object()

        cache = ModelCache(1, loader)
        p = tmp_path / "model-a"
        a, b = await asyncio.gather(cache.acquire(p), cache.acquire(p))
        assert a is b and loads == [p]
        with pytest.raises(SpeechError):
            await cache.acquire(tmp_path / "model-b")
        await cache.release(p)
        await cache.release(p)
        await cache.acquire(tmp_path / "model-b")
        assert len(cache.entries) == 1 and len(loads) == 2
        await cache.aclose()

    asyncio.run(run())


def test_cancelled_model_load_remains_bounded_and_reusable(tmp_path):
    async def run():
        entered, release = threading.Event(), threading.Event()

        def loader(path):
            entered.set()
            assert release.wait(3)
            return object()

        cache = ModelCache(1, loader)
        task = asyncio.create_task(cache.acquire(tmp_path))
        while not entered.is_set():
            await asyncio.sleep(0.001)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cache.entries[tmp_path].users == 0
        with pytest.raises(SpeechError):
            await cache.acquire(tmp_path / "second")
        release.set()
        await cache.acquire(tmp_path)
        await cache.release(tmp_path)
        await cache.aclose()

    asyncio.run(run())


def test_both_profiles_use_distinct_paths_and_independent_recognizers(tmp_path):
    async def run():
        settings = Settings()
        loads = []
        for profile in ("whisper-small", "whisper-medium"):
            model_path = tmp_path / profile
            (model_path / "am").mkdir(parents=True)
            (model_path / "conf").mkdir()
            (model_path / "graph").mkdir()
            (model_path / "model.bin").touch()
            (model_path / "config.json").touch()
            (model_path / "tokenizer.json").touch()
            settings.transcription.profiles[profile].model_path = str(model_path)

        def loader(path):
            loads.append(path)
            return object()

        registry = SpeechRegistry(
            settings,
            model_loader=loader,
            engine_factory=lambda cfg, model: mock_engine(cfg, "request-flow"),
        )
        a = await registry.open_stream(config("us", "whisper-small"))
        b = await registry.open_stream(config("india", "whisper-medium"))
        assert a.engine is not b.engine
        assert set(loads) == {tmp_path / "whisper-small", tmp_path / "whisper-medium"}
        await registry.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("profile", ["whisper-small", "whisper-medium"])
def test_optional_real_whisper_silence_smoke(profile):
    settings = Settings()
    if not whisper_installed() or not model_valid(settings.model_path(profile)):
        pytest.skip(f"{profile}: install the speech extra and model to run real Whisper smoke")

    async def run():
        registry = SpeechRegistry(settings)
        stream = await registry.open_stream(config("real", profile))
        for _ in range(5):
            await stream.push_audio(bytes(3200))
        await stream.finish()
        assert [e async for e in stream.events()] == []
        await registry.aclose()
        assert registry.active == 0

    asyncio.run(run())
