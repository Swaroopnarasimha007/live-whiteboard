from threading import Lock
from types import SimpleNamespace

import pytest

np = pytest.importorskip("numpy")
pytest.importorskip("faster_whisper")

from app.config import Settings
from app.contracts.audio import SpeechStreamConfig
from app.speech.whisper import WhisperEngine


def engine(vad=None):
    calls = []

    def transcribe(audio, **options):
        calls.append((len(audio), options))
        words = [
            SimpleNamespace(start=0.05, end=0.15, word=" old"),
            SimpleNamespace(start=0.6, end=0.8, word=" new"),
        ]
        return iter([SimpleNamespace(words=words)]), None

    resource = SimpleNamespace(model=SimpleNamespace(transcribe=transcribe), lock=Lock())
    settings = Settings().transcription.endpointing
    config = SpeechStreamConfig(streamId="hold1", sessionEpoch=4, profile="whisper-small")
    vad = vad or (lambda audio: [{"start": 0, "end": len(audio)}] if np.any(audio) else [])
    return WhisperEngine(config, resource, "en", settings, vad=vad), calls


FRAME = np.full(1600, 5000, dtype="<i2").tobytes()


def test_short_hold_transcribes_only_on_release_and_never_emits_partials():
    speech, calls = engine()
    for _ in range(50):
        assert speech.push(FRAME) == []
    assert calls == []
    events = speech.finish()
    assert len(events) == 1 and events[0].isFinal
    assert events[0].startMs == 0 and events[0].endMs == 5000
    assert speech.finish() == []
    assert calls[0][1]["word_timestamps"] is True


def test_long_hold_commits_at_limit_and_overlap_words_belong_to_one_chunk():
    speech, calls = engine()
    events = []
    for _ in range(310):
        events.extend(speech.push(FRAME))
    assert len(events) == 2  # progress before release
    events.extend(speech.finish())
    assert [(e.startMs, e.endMs) for e in events] == [(0, 15000), (15000, 30000), (30000, 31000)]
    assert events[0].text == "old new"
    assert events[1].text == events[2].text == "new"
    assert len({e.id for e in events}) == 3
    assert len(calls) == 3


def test_pause_boundary_and_silence_do_not_send_empty_transcripts():
    def vad(audio):
        voiced = np.flatnonzero(audio)
        return [{"start": int(voiced[0]), "end": int(voiced[-1]) + 1}] if len(voiced) else []

    speech, calls = engine(vad)
    events = []
    for _ in range(74):
        events.extend(speech.push(FRAME))
    for _ in range(10):
        events.extend(speech.push(bytes(3200)))
    assert len(events) == 1 and events[0].endMs == 8000
    assert speech.finish() == []
    assert len(calls) == 1


def test_cancellation_discards_only_uncommitted_audio():
    speech, calls = engine()
    speech.push(FRAME)
    speech.close()
    assert speech.finish() == []
    assert calls == []
