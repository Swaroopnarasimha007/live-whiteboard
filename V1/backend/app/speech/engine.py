"""Synchronous recognition engine; every method runs on its stream's ordered worker."""

import json

from app.contracts.audio import SpeechStreamConfig, TranscriptEvent


class SegmentEngine:
    def __init__(self, config: SpeechStreamConfig, factory):
        self.config, self.factory = config, factory
        self.recognizer = factory()
        self.samples = 0
        self.segment_start = 0
        self.segment = 1
        self.partial = ""
        self.last_partial_sample = -config.format.sampleRateHz
        self.limit = max(1, config.maxSegmentMs * config.format.sampleRateHz // 1000)

    def emit(self, text: str, final: bool):
        text = text.strip()
        if not text:
            return []
        rate = self.config.format.sampleRateHz
        return [
            TranscriptEvent(
                type="transcript",
                streamId=self.config.streamId,
                sessionEpoch=self.config.sessionEpoch,
                id=f"{self.config.streamId}_{self.segment}",
                text=text,
                startMs=self.segment_start * 1000 / rate,
                endMs=self.samples * 1000 / rate,
                isFinal=final,
            )
        ]

    def boundary(self):
        self.segment += 1
        self.segment_start = self.samples
        self.partial = ""
        # Throttling applies across boundaries, not just within one utterance.

    def push(self, frame: bytes):
        events = []
        offset = 0
        while offset < len(frame):
            count = min(
                (len(frame) - offset) // 2, self.limit - (self.samples - self.segment_start)
            )
            piece = frame[offset : offset + count * 2]
            offset += count * 2
            self.samples += count
            if self.recognizer.AcceptWaveform(piece):
                events.extend(self.emit(json.loads(self.recognizer.Result()).get("text", ""), True))
                self.boundary()
            elif self.samples - self.segment_start >= self.limit:
                events.extend(
                    self.emit(json.loads(self.recognizer.FinalResult()).get("text", ""), True)
                )
                self.recognizer = self.factory()
                self.boundary()
            else:
                text = json.loads(self.recognizer.PartialResult()).get("partial", "").strip()
                interval = (
                    self.config.partialEmitIntervalMs * self.config.format.sampleRateHz / 1000
                )
                if (
                    text
                    and text != self.partial
                    and self.samples - self.last_partial_sample >= interval
                ):
                    events.extend(self.emit(text, False))
                    self.partial, self.last_partial_sample = text, self.samples
        return events

    def finish(self):
        result = self.emit(json.loads(self.recognizer.FinalResult()).get("text", ""), True)
        self.boundary()
        return result

    def close(self):
        self.recognizer = None
        self.factory = None
