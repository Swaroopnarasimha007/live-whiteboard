import json

from .engine import SegmentEngine
from .errors import SpeechError

FIXTURES = {"request-flow", "silence", "continuous", "error"}
PHRASES = (
    "the browser sends a request",
    "the server queries the database",
    "the server returns a response",
)


class MockRecognizer:
    def __init__(self, fixture: str):
        self.fixture, self.samples, self.index = fixture, 0, 0

    def AcceptWaveform(self, frame: bytes):
        self.samples += len(frame) // 2
        if self.fixture == "error" and self.samples >= 4800:
            raise SpeechError("recognition_failed", "Mock recognition failure fixture.")
        return self.fixture == "request-flow" and self.samples >= 16000

    def words(self):
        if self.fixture == "silence" or self.samples < 2400:
            return ""
        words = PHRASES[self.index % len(PHRASES)].split()
        return " ".join(words[: min(len(words), max(1, self.samples // 2400))])

    def PartialResult(self):
        return json.dumps({"partial": self.words()})

    def Result(self):
        text = PHRASES[self.index % len(PHRASES)]
        self.samples = 0
        self.index += 1
        return json.dumps({"text": text})

    def FinalResult(self):
        text = self.words()
        self.samples = 0
        return json.dumps({"text": text})


def mock_engine(config, fixture):
    if fixture not in FIXTURES:
        raise SpeechError("profile_unavailable", "Unknown mock speech fixture.")
    return SegmentEngine(config, lambda: MockRecognizer(fixture))
