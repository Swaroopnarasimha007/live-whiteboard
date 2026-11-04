import json

import httpx
from websockets.sync.client import connect

from app.config import Settings
from app.main import create_app
from tests.integration.listener import listening


def test_audio_overload_is_explicit_and_reset_rejects_old_epoch_over_real_ws():
    settings = Settings()
    settings.transcription.audio.max_buffer_ms = 200
    with listening(create_app(settings)) as url, httpx.Client(base_url=url) as client:
        identity = client.post("/api/v1/sessions", json={}).json()
        sid = identity["sessionId"]
        start = {
            "type": "start",
            "audioProtocolVersion": 1,
            "streamId": "overload",
            "sessionEpoch": 0,
            "profile": "mock",
            "format": {"encoding": "pcm_s16le", "sampleRateHz": 16000, "channels": 1},
        }
        with connect(
            url.replace("http", "ws") + f"/api/v1/sessions/{sid}/audio",
            origin="http://localhost:5173",
            open_timeout=5,
        ) as ws:
            ws.send(json.dumps(start))
            assert json.loads(ws.recv(timeout=5))["type"] == "ready"
            ws.send(bytes(32000))  # Valid 1s frame exceeds explicitly configured 200ms audio queue.
            error = json.loads(ws.recv(timeout=5))
            assert error["type"] == "error" and error["code"] == "overloaded"
            assert json.loads(ws.recv(timeout=5))["type"] == "closed"
        reset = client.post(
            f"/api/v1/sessions/{sid}/reset", json={"sessionId": sid, "sessionEpoch": 0}
        )
        assert reset.status_code == 200
        with connect(
            url.replace("http", "ws") + f"/api/v1/sessions/{sid}/audio",
            origin="http://localhost:5173",
            open_timeout=5,
        ) as ws:
            ws.send(json.dumps({**start, "streamId": "late"}))
            error = json.loads(ws.recv(timeout=5))
            assert error["type"] == "error" and error["code"] == "stale_epoch"


def test_disabled_client_profile_selection_uses_backend_default_over_tcp():
    settings = Settings()
    settings.transcription.allow_client_profile_selection = False
    with listening(create_app(settings)) as url, httpx.Client(base_url=url) as client:
        assert client.post("/api/v1/sessions", json={}).json()["profile"] == "mock"
        rejected = client.post("/api/v1/sessions", json={"profile": "whisper-small"})
        assert rejected.status_code != 201
        assert rejected.json()["error"]["code"] == "profile_selection_disabled"
