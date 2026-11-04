from typing import Annotated, Literal

from pydantic import Field, TypeAdapter, model_validator

from .base import Contract, Counter, Id


class AudioFormat(Contract):
    encoding: Literal["pcm_s16le"] = "pcm_s16le"
    sampleRateHz: Literal[16000] = 16000
    channels: Literal[1] = 1


class AudioStart(Contract):
    type: Literal["start"]
    audioProtocolVersion: Literal[1]
    streamId: Id
    sessionEpoch: Counter
    profile: Id
    format: AudioFormat


class AudioControl(Contract):
    type: Literal["finish", "abort"]


class AudioEventBase(Contract):
    streamId: Id
    sessionEpoch: Counter


class AudioReady(AudioEventBase):
    type: Literal["ready"]
    profile: Id
    format: AudioFormat


class TranscriptEvent(AudioEventBase):
    type: Literal["transcript"]
    id: Id
    text: str
    startMs: Annotated[float, Field(ge=0)]
    endMs: Annotated[float, Field(ge=0)]
    isFinal: bool

    @model_validator(mode="after")
    def check(self):
        if self.endMs < self.startMs:
            raise ValueError("Invalid transcript interval")
        return self


class AudioError(AudioEventBase):
    type: Literal["error"]
    code: str
    message: str


class AudioProgress(AudioEventBase):
    type: Literal["progress"] = "progress"
    stage: Literal["transcribing", "listening"]


class AudioProcessed(AudioEventBase):
    type: Literal["processed"] = "processed"
    samples: Counter


class AudioClosed(AudioEventBase):
    type: Literal["closed"]
    reason: Literal["finished", "aborted", "error"]


AudioClientMessage = Annotated[AudioStart | AudioControl, Field(discriminator="type")]
AudioServerEvent = Annotated[
    AudioReady | TranscriptEvent | AudioProgress | AudioProcessed | AudioError | AudioClosed,
    Field(discriminator="type"),
]
audio_client_adapter = TypeAdapter(AudioClientMessage)
audio_event_adapter = TypeAdapter(AudioServerEvent)


class SpeechStreamConfig(Contract):
    streamId: Id
    sessionEpoch: Counter
    profile: Id
    format: AudioFormat = Field(default_factory=AudioFormat)
    maxBufferMs: Annotated[int, Field(ge=100)] = 2000
    partialEmitIntervalMs: Annotated[int, Field(gt=0)] = 150
    maxSegmentMs: Annotated[int, Field(gt=0)] = 4000


def validate_pcm_frame(frame: bytes, format: AudioFormat) -> None:
    if not frame or len(frame) % 2 or len(frame) > format.sampleRateHz * format.channels * 2:
        raise ValueError("PCM frame must contain 1–16000 aligned 16-bit samples")
