import asyncio
import json
from collections import deque
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.contracts.audio import audio_event_adapter
from app.speech import SpeechError, SpeechRegistry
from app.speech.socket import AudioSocketService


class BoundSession:
    session_id = "test-session"
    session_epoch = 1
    profile = "mock"
    active = None
    epoch_at_claim = None

    def __init__(self):
        self.seen = set()

    async def claim_audio(self, stream_id):
        if self.active or stream_id in self.seen:
            raise SpeechError(
                "capture_conflict", "Start a new stream after stopping the old capture."
            )
        self.active = stream_id
        self.epoch_at_claim = self.session_epoch
        self.seen.add(stream_id)

    async def release_audio(self, stream_id):
        if self.active == stream_id:
            self.active = None

    def audio_is_current(self, stream_id):
        return self.active == stream_id and self.session_epoch == self.epoch_at_claim


def harness(settings=None):
    registry = SpeechRegistry(settings or Settings())
    binding = BoundSession()

    @asynccontextmanager
    async def lifespan(app):
        yield
        await registry.aclose()

    app = FastAPI(lifespan=lifespan)

    @app.websocket("/audio")
    async def audio(ws: WebSocket):
        await AudioSocketService(registry).handle(ws, binding)

    return TestClient(app), registry, binding


def start(stream="a1", **overrides):
    return {
        "type": "start",
        "audioProtocolVersion": 1,
        "streamId": stream,
        "sessionEpoch": 1,
        "profile": "mock",
        "format": {"encoding": "pcm_s16le", "sampleRateHz": 16000, "channels": 1},
        **overrides,
    }


def until_closed(ws):
    events = []
    while True:
        event = ws.receive_json()
        audio_event_adapter.validate_json(json.dumps(event))
        events.append(event)
        if event["type"] == "closed":
            return events


def test_session_bound_socket_transcripts_finish_and_cleanup():
    client, registry, binding = harness()
    with (
        client,
        client.websocket_connect("/audio", headers={"Origin": "http://localhost:5173"}) as ws,
    ):
        ws.send_json(start())
        assert ws.receive_json()["type"] == "ready"
        for _ in range(10):
            ws.send_bytes(bytes(3200))
        ws.send_json({"type": "finish"})
        events = until_closed(ws)
        finals = [e for e in events if e["type"] == "transcript" and e["isFinal"]]
        assert finals == [
            {
                "type": "transcript",
                "streamId": "a1",
                "sessionEpoch": 1,
                "id": "a1_1",
                "text": "the browser sends a request",
                "startMs": 0.0,
                "endMs": 1000.0,
                "isFinal": True,
            }
        ]
        assert events[-1]["reason"] == "finished"
    assert registry.active == 0 and binding.active is None


def test_abort_and_disconnect_do_not_emit_late_finals():
    client, registry, binding = harness()
    with client:
        with client.websocket_connect("/audio", headers={"Origin": "http://localhost:5173"}) as ws:
            ws.send_json(start())
            ws.receive_json()
            ws.send_bytes(bytes(6400))
            ws.send_json({"type": "abort"})
            events = until_closed(ws)
            assert events[-1]["reason"] == "aborted"
            assert not any(e.get("isFinal") for e in events)
        with client.websocket_connect("/audio", headers={"Origin": "http://localhost:5173"}) as ws:
            ws.send_json(start("a2"))
            assert ws.receive_json()["type"] == "ready"
            ws.send_bytes(bytes(3200))
    assert registry.active == 0 and binding.active is None


@pytest.mark.parametrize(
    "failure", [WebSocketDisconnect, OSError, RuntimeError, asyncio.TimeoutError]
)
def test_abort_acknowledgement_after_client_close_releases_capture(failure):
    async def run():
        registry, binding = SpeechRegistry(Settings()), BoundSession()
        incoming = deque(
            [
                {"type": "websocket.connect"},
                {"type": "websocket.receive", "text": json.dumps(start())},
                {"type": "websocket.receive", "text": '{"type":"abort"}'},
            ]
        )
        attempted = []

        async def receive():
            return incoming.popleft()

        async def send(message):
            attempted.append(message)
            if message["type"] == "websocket.send":
                event = json.loads(message["text"])
                if event["type"] == "closed":
                    assert event["reason"] == "aborted"
                    raise failure()

        socket = WebSocket(
            {"type": "websocket", "headers": [(b"origin", b"http://localhost:5173")]},
            receive,
            send,
        )
        try:
            await AudioSocketService(registry).handle(socket, binding)
            assert binding.active is None
            assert not any(message["type"] == "websocket.close" for message in attempted)
        finally:
            await registry.aclose()
        assert registry.active == 0

    asyncio.run(run())


@pytest.mark.parametrize("message", [None, {"type": "finish"}, {"type": "start"}, "x" * 4097])
def test_bad_handshake_and_audio_before_start(message):
    client, registry, _binding = harness()
    with (
        client,
        client.websocket_connect("/audio", headers={"Origin": "http://localhost:5173"}) as ws,
    ):
        if message is None:
            ws.send_bytes(bytes(3200))
        elif isinstance(message, str):
            ws.send_text(message)
        else:
            ws.send_json(message)
        with pytest.raises(WebSocketDisconnect) as error:
            ws.receive_json()
        assert error.value.code == 1008
    assert registry.active == 0


def test_epoch_profile_mutation_invalid_audio_and_explicit_overload():
    for action, code in [
        ("epoch", "stale_epoch"),
        ("switch", "invalid_control"),
        ("odd", "invalid_audio"),
        ("overload", "overloaded"),
    ]:
        settings = Settings()
        if action == "overload":
            settings.transcription.audio.max_buffer_ms = 100
        client, registry, binding = harness(settings)
        with (
            client,
            client.websocket_connect("/audio", headers={"Origin": "http://localhost:5173"}) as ws,
        ):
            ws.send_json(start(sessionEpoch=2) if action == "epoch" else start())
            if action != "epoch":
                assert ws.receive_json()["type"] == "ready"
                if action == "switch":
                    ws.send_json(start(profile="whisper-small"))
                else:
                    ws.send_bytes(b"x" if action == "odd" else bytes(6400))
            events = until_closed(ws)
            assert events[-2]["code"] == code and events[-1]["reason"] == "error"
        assert registry.active == 0 and binding.active is None


def test_origin_and_reused_stream_are_rejected():
    client, registry, _binding = harness()
    with client:
        with (
            pytest.raises(WebSocketDisconnect) as error,
            client.websocket_connect("/audio", headers={"Origin": "https://evil.example"}),
        ):
            pass
        assert error.value.code == 1008
        for attempt in range(2):
            with client.websocket_connect(
                "/audio", headers={"Origin": "http://localhost:5173"}
            ) as ws:
                ws.send_json(start())
                if attempt == 0:
                    assert ws.receive_json()["type"] == "ready"
                    ws.send_json({"type": "finish"})
                    assert until_closed(ws)[-1]["reason"] == "finished"
                else:
                    assert until_closed(ws)[0]["code"] == "capture_conflict"
    assert registry.active == 0
