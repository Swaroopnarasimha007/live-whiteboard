import json

import httpx
import pytest

from app.api.test_routes import generation
from app.config import Settings
from app.main import create_app
from tests.integration.listener import listening


@pytest.mark.parametrize(
    "fixture,terminal", [("fragmented", "completed"), ("invalid", "completed"), ("error", "failed")]
)
def test_real_tcp_fragmentation_corruption_failure_and_replay(fixture, terminal):
    settings = Settings()
    settings.diagram.profiles["mock"].model = fixture
    with listening(create_app(settings)) as url, httpx.Client(base_url=url) as client:
        identity = client.post("/api/v1/sessions", json={}).json()
        body = generation(identity)
        with client.stream("POST", "/api/v1/generations", json=body) as response:
            assert response.status_code == 200
            assert "no-transform" in response.headers["cache-control"]
            assert "content-encoding" not in response.headers
            events = [json.loads(line) for line in response.iter_lines()]
        assert events[0]["event"] == "started" and events[-1]["event"] == terminal
        assert any(event["event"] == "operation" for event in events)
        assert [event["sequence"] for event in events] == list(range(1, len(events) + 1))
        if fixture == "invalid":
            assert any(event["event"] == "warning" for event in events)
        owner = {"sessionId": identity["sessionId"], "sessionEpoch": 0}
        replay = client.get("/api/v1/generations/r1/events", params={**owner, "after": 1})
        assert [json.loads(line) for line in replay.iter_lines()] == events[1:]
        assert client.post("/api/v1/generations", json=body).text.splitlines() == [
            json.dumps(event, separators=(",", ":"), ensure_ascii=False) for event in events
        ]


def test_long_session_capacity_is_bounded_and_released_over_tcp():
    settings = Settings()
    settings.sessions.max_sessions = 2
    with listening(create_app(settings)) as url, httpx.Client(base_url=url) as client:
        for _ in range(25):
            identities = [client.post("/api/v1/sessions", json={}).json() for _ in range(2)]
            assert client.post("/api/v1/sessions", json={}).status_code == 429
            for identity in identities:
                sid = identity["sessionId"]
                assert (
                    client.delete(f"/api/v1/sessions/{sid}", params={"sessionEpoch": 0}).status_code
                    == 204
                )
                assert (
                    client.get(f"/api/v1/sessions/{sid}", params={"sessionEpoch": 0}).status_code
                    == 410
                )
