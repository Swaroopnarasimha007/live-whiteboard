"""Local streaming reverse-proxy acceptance. Not a claim to have executed nginx."""

import asyncio
import json
import threading

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from app.api.test_routes import generation
from app.config import Settings
from app.contracts.operations import operation_adapter
from app.diagram import CompletedResult, OperationResult
from app.main import create_app
from tests.integration.listener import listening


def test_reverse_proxy_delivers_first_record_before_releasing_completion():
    release = threading.Event()

    async def configure(app, stack):
        real = app.state.generation_service

        class Gated:
            def prepare(self, *args, **kwargs):
                return real.prepare(*args, **kwargs)

            async def generate(self, prepared, **kwargs):
                yield OperationResult(
                    operation_adapter.validate_python(
                        {"op": "section.add", "id": "g_r1_probe", "title": "Proxy probe"}
                    )
                )
                while not release.is_set():
                    await asyncio.sleep(0.01)
                yield CompletedResult(1, 0)

        app.state.generation_service = Gated()

    with listening(create_app(Settings(), configure=configure)) as upstream:
        proxy = FastAPI()

        @proxy.post("/api/v1/generations")
        async def forward(request: Request):
            body = await request.body()

            async def chunks():
                async with (
                    httpx.AsyncClient() as client,
                    client.stream(
                        "POST",
                        upstream + "/api/v1/generations",
                        content=body,
                        headers={"content-type": "application/json"},
                    ) as response,
                ):
                    async for chunk in response.aiter_raw():
                        yield chunk

            return StreamingResponse(
                chunks(),
                media_type="application/x-ndjson",
                headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
            )

        try:
            with listening(proxy) as url, httpx.Client(timeout=5) as client:
                identity = client.post(upstream + "/api/v1/sessions", json={}).json()
                with client.stream(
                    "POST",
                    url + "/api/v1/generations",
                    json=generation(identity),
                    headers={"Accept-Encoding": "gzip"},
                ) as response:
                    assert "content-encoding" not in response.headers
                    assert response.headers["x-accel-buffering"] == "no"
                    events = response.iter_lines()
                    assert json.loads(next(events))["event"] == "started"
                    assert json.loads(next(events))["event"] == "operation"
                    assert not release.is_set()
                    release.set()
                    assert json.loads(next(events))["event"] == "completed"
        finally:
            release.set()
