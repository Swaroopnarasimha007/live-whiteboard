"""B3 transport component test over a real TCP listener (no model/network provider)."""

import asyncio
import json
import socket
import threading
import time

import httpx
import uvicorn

from app.api.test_routes import generation
from app.config import Settings
from app.contracts.operations import operation_adapter
from app.diagram import OperationResult
from app.main import create_app


def test_incremental_tcp_delivery_disconnect_and_idempotent_replay():
    class PausedService:
        calls = 0
        closed = 0

        def __init__(self, real):
            self.real = real

        def prepare(self, *args, **kwargs):
            return self.real.prepare(*args, **kwargs)

        async def generate(self, prepared, state):
            self.calls += 1
            try:
                yield OperationResult(
                    operation_adapter.validate_python(
                        {
                            "op": "section.add",
                            "id": "g_r1_first",
                            "title": "Visible before completion",
                        }
                    )
                )
                await asyncio.sleep(60)
            finally:
                self.closed += 1

    async def configure(app, stack):
        app.state.generation_service = PausedService(app.state.generation_service)

    app = create_app(Settings(), configure=configure)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", ws="none"))
    worker = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    worker.start()
    try:
        deadline = time.monotonic() + 5
        while not server.started:
            assert worker.is_alive() and time.monotonic() < deadline
            time.sleep(0.01)
        with httpx.Client(
            base_url=f"http://127.0.0.1:{listener.getsockname()[1]}", timeout=3
        ) as client:
            session = client.post("/api/v1/sessions", json={}).json()
            body = generation(session)
            with client.stream("POST", "/api/v1/generations", json=body) as response:
                assert response.status_code == 200
                assert response.headers["x-accel-buffering"] == "no"
                events = response.iter_lines()
                assert json.loads(next(events))["event"] == "started"
                first = json.loads(next(events))
                assert first["event"] == "operation" and first["sequence"] == 2
                assert app.state.generation_service.closed == 0
                busy = {**body, "requestId": "r2", "idPrefix": "g_r2_"}
                assert client.post("/api/v1/generations", json=busy).status_code == 409
            # The connection has ended while the producer is paused; replay tails the cancellation.
            time.sleep(0.2)
            owner = {"sessionId": session["sessionId"], "sessionEpoch": 0}
            replay = client.get("/api/v1/generations/r1/events", params={**owner, "after": 1})
            retained = [json.loads(line) for line in replay.text.splitlines()]
            assert retained[0] == first
            assert retained[-1]["event"] == "cancelled"
            assert [event["sequence"] for event in retained] == [2, 3]
            duplicate = client.post("/api/v1/generations", json=body)
            assert [json.loads(line) for line in duplicate.text.splitlines()][1:] == retained
            for _ in range(2):
                assert client.post("/api/v1/generations/r1/cancel", json=owner).status_code == 200
            assert app.state.generation_service.calls == app.state.generation_service.closed == 1
    finally:
        server.should_exit = True
        worker.join(timeout=5)
        listener.close()
        assert not worker.is_alive()
