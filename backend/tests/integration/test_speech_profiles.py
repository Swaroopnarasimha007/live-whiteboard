"""Opt-in real Whisper + WAV path; no downloads or synthesis during normal CI."""

import asyncio
import json
import os
import wave

import pytest

from app.config import BACKEND_DIR, Settings
from app.contracts.audio import SpeechStreamConfig
from app.speech.registry import SpeechRegistry

FIXTURES = BACKEND_DIR.parent / "benchmarks/backend/fixtures"


@pytest.mark.parametrize("profile", ["whisper-small", "whisper-medium"])
def test_real_profile_synthetic_wav_finalizes_and_releases(profile, record_property):
    if os.environ.get("WHITEBOARD_MODEL_TESTS") != "1":
        pytest.skip("real Whisper WAV test opt-in: WHITEBOARD_MODEL_TESTS=1")
    path = FIXTURES / "technical-16k.wav"
    if not path.exists():
        pytest.fail(
            "Generate speech and production-resampled technical-16k.wav first; see B4 runbook"
        )
    with wave.open(str(path), "rb") as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 16000)
        pcm = wav.readframes(wav.getnframes())

    async def run():
        registry = SpeechRegistry(Settings())
        ready, reason = registry.availability(profile)
        if not ready:
            pytest.fail(f"{profile}: {reason}; install both model profiles")
        stream = await registry.open_stream(
            SpeechStreamConfig(streamId="b4speech", sessionEpoch=0, profile=profile)
        )
        events = []

        async def consume():
            events.extend([event async for event in stream.events()])

        consumer = asyncio.create_task(consume())
        try:
            for offset in range(0, len(pcm), 3200):
                await stream.push_audio(pcm[offset : offset + 3200])
            await stream.finish()
            await consumer
            await stream.wait_closed()
            finals = [event for event in events if getattr(event, "isFinal", False)]
            assert len(finals) >= 1
            assert all(event.endMs - event.startMs <= 15000 for event in finals)
            assert registry.active == 0 and not registry.streams
            record_property("profile", profile)
            record_property("transcript", " ".join(event.text for event in finals))
            record_property(
                "provenance",
                json.loads((FIXTURES / "technical.json").read_text(encoding="utf-8-sig"))[
                    "provenance"
                ],
            )
        finally:
            await registry.aclose()

    asyncio.run(run())
