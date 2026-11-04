"""Final-only hold chunks. Methods run on the stream's ordered worker thread."""

import time

from app.contracts.audio import TranscriptEvent
from app.diagnostics import diagnostic


class WhisperEngine:
    def __init__(self, config, resource, language, endpointing, *, vad=None, progress=None):
        import numpy as np
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        self.np = np
        self.config, self.resource, self.language = config, resource, language
        self.progress = progress or (lambda stage: None)
        self.rate = config.format.sampleRateHz
        self.maximum = endpointing.max_segment_ms * self.rate // 1000
        self.target = endpointing.target_chunk_ms * self.rate // 1000
        self.silence = endpointing.silence_ms * self.rate // 1000
        self.context = endpointing.context_ms * self.rate // 1000
        self.vad = vad or (
            lambda audio: get_speech_timestamps(
                audio,
                VadOptions(
                    min_silence_duration_ms=endpointing.silence_ms,
                    speech_pad_ms=0,
                    min_speech_duration_ms=150,
                ),
            )
        )
        self.buffer = bytearray()
        self.lookback = b""
        self.committed = self.sequence = 0
        self.next_check = self.target

    def audio(self, data):
        return self.np.frombuffer(data, dtype="<i2").astype(self.np.float32) / 32768.0

    def push(self, frame):
        self.buffer.extend(frame)
        samples = len(self.buffer) // 2
        if samples < self.next_check:
            return []
        speech = self.vad(self.audio(self.buffer))
        # Close at the end of a confirmed pause, preserving every captured sample.
        cut = next(
            (
                s["end"] + self.silence
                for s in speech
                if s["end"] + self.silence >= self.target and samples - s["end"] >= self.silence
            ),
            None,
        )
        if cut is None and samples >= self.maximum:
            cut = self.maximum
        if cut is not None:
            return self.commit(min(cut, self.maximum))
        self.next_check = min(samples + self.rate // 2, self.maximum)
        return []

    def commit(self, count):
        if not count:
            return []
        started = time.monotonic()
        owned = bytes(self.buffer[: count * 2])
        audio = self.audio(self.lookback + owned)
        context_samples = len(self.lookback) // 2
        words = []
        if self.vad(self.audio(owned)):
            self.progress("transcribing")
            # A resource lock serializes inference even when two holds share a model.
            with self.resource.lock:
                segments, _ = self.resource.model.transcribe(
                    audio,
                    language=self.language,
                    beam_size=1,
                    temperature=0,
                    condition_on_previous_text=False,
                    word_timestamps=True,
                    vad_filter=False,
                )
                for segment in segments:
                    for word in segment.words or []:
                        midpoint = (word.start + word.end) * self.rate / 2
                        if context_samples <= midpoint < context_samples + count:
                            words.append(word.word)
            self.progress("listening")
        text = "".join(words).strip()
        start = self.committed
        self.committed += count
        self.sequence += 1
        self.lookback = (self.lookback + owned)[-self.context * 2 :] if self.context else b""
        del self.buffer[: count * 2]
        self.next_check = self.target
        diagnostic(
            "speech.chunk_finalized",
            hold_id=self.config.streamId,
            sequence=self.sequence,
            audio_ms=count * 1000 / self.rate,
            characters=len(text),
            elapsed_ms=round((time.monotonic() - started) * 1000),
        )
        if not text:
            return []
        return [
            TranscriptEvent(
                type="transcript",
                streamId=self.config.streamId,
                sessionEpoch=self.config.sessionEpoch,
                id=f"{self.config.streamId}_{self.sequence}",
                text=text,
                startMs=start * 1000 / self.rate,
                endMs=self.committed * 1000 / self.rate,
                isFinal=True,
            )
        ]

    def finish(self):
        return self.commit(len(self.buffer) // 2)

    def close(self):
        self.buffer.clear()
        self.lookback = b""
        self.resource = None
