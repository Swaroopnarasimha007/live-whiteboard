import json

from fastapi.testclient import TestClient

from app.config import BACKEND_DIR, Settings
from app.main import create_app


def generation(session, request_id="r1"):
    fixtures = json.loads(
        (BACKEND_DIR.parent / "shared/protocol/v1/fixtures.json").read_text(encoding="utf-8")
    )
    body = fixtures["generation-request"]["valid"][0]
    body.update(
        sessionId=session["sessionId"],
        sessionEpoch=session["sessionEpoch"],
        requestId=request_id,
        idPrefix=f"g_{request_id}_",
    )
    body["transcript"]["text"] = (
        "The browser sends a request to the server, which queries the database"
    )
    return body


def test_session_stream_replay_conflict_reset_and_expiry():
    app = create_app(Settings())
    with TestClient(app) as client:
        created = client.post("/api/v1/sessions", json={})
        assert created.status_code == 201
        session = created.json()
        sid = session["sessionId"]
        assert sid.startswith("bs_") and session["sessionEpoch"] == 0
        body = generation(session)
        result = client.post("/api/v1/generations", json=body)
        assert result.status_code == 200 and result.headers["content-type"].startswith(
            "application/x-ndjson"
        )
        assert result.headers["x-accel-buffering"] == "no"
        events = [json.loads(line) for line in result.text.splitlines()]
        assert events[0]["event"] == "started" and events[-1]["event"] == "completed"
        assert [event["sequence"] for event in events] == list(range(1, len(events) + 1))
        assert client.post("/api/v1/generations", json=body).text == result.text
        replay = client.get(
            "/api/v1/generations/r1/events",
            params={"sessionId": sid, "sessionEpoch": 0, "after": 2},
        )
        assert replay.text.splitlines() == result.text.splitlines()[2:]
        body["transcript"]["text"] += " different content"
        assert client.post("/api/v1/generations", json=body).status_code == 409
        other = client.post("/api/v1/sessions", json={}).json()
        assert (
            client.get(
                "/api/v1/generations/r1/events",
                params={"sessionId": other["sessionId"], "sessionEpoch": 0},
            ).status_code
            == 410
        )
        owner = {"sessionId": sid, "sessionEpoch": 0}
        assert client.post("/api/v1/generations/r1/cancel", json=owner).status_code == 200
        reset = client.post(f"/api/v1/sessions/{sid}/reset", json=owner)
        assert reset.status_code == 200 and reset.json()["sessionEpoch"] == 1
        assert client.get("/api/v1/generations/r1/events", params={**owner}).status_code == 409
        assert (
            client.delete(f"/api/v1/sessions/{sid}", params={"sessionEpoch": 1}).status_code == 204
        )
        assert (
            client.delete(f"/api/v1/sessions/{sid}", params={"sessionEpoch": 1}).status_code == 204
        )
        assert client.get(f"/api/v1/sessions/{sid}", params={"sessionEpoch": 1}).status_code == 410


def test_origins_capacity_selection_and_audio_mount():
    settings = Settings()
    settings.sessions.max_sessions = 1
    with TestClient(create_app(settings)) as client:
        assert (
            client.post(
                "/api/v1/sessions", json={}, headers={"Origin": "https://evil.example"}
            ).status_code
            == 403
        )
        assert client.post("/api/v1/sessions", json={"profile": "unapproved"}).status_code == 503
        session = client.post("/api/v1/sessions", json={"sessionEpoch": 4}).json()
        assert session["sessionEpoch"] == 4
        assert client.post("/api/v1/sessions", json={}).status_code == 429
        sid = session["sessionId"]
        with client.websocket_connect(
            f"/api/v1/sessions/{sid}/audio", headers={"Origin": "http://localhost:5173"}
        ) as ws:
            ws.send_json(
                {
                    "type": "start",
                    "audioProtocolVersion": 1,
                    "streamId": "a1",
                    "sessionEpoch": 4,
                    "profile": "mock",
                    "format": {"encoding": "pcm_s16le", "sampleRateHz": 16000, "channels": 1},
                }
            )
            assert ws.receive_json()["type"] == "ready"
            ws.send_bytes(bytes(32000))
            ws.send_json({"type": "finish"})
            events = []
            while True:
                event = ws.receive_json()
                events.append(event)
                if event["type"] == "closed":
                    break
            assert any(event.get("isFinal") for event in events)
            assert events[-1]["reason"] == "finished"
        caps = client.get("/api/v1/capabilities").json()
        assert caps["stage"] == "B3" and all(caps["services"].values())
