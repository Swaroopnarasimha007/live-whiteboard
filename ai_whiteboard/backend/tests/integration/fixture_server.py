"""Dedicated B4 mock server; never exposes fixture controls in production routes."""

import asyncio
import json

import uvicorn
from fastapi import Request
from fastapi.responses import StreamingResponse

from app.config import Settings
from app.contracts.operations import operation_adapter
from app.diagram import CompletedResult, OperationResult, WarningResult
from app.main import create_app


async def configure(app, stack):
    real = app.state.generation_service

    class Paused:
        def prepare(self, *args, **kwargs):
            return real.prepare(*args, **kwargs)

        async def generate(self, prepared, **kwargs):
            data = json.loads(prepared.request_json)
            if data["transcript"]["text"] == "B4 stale update":
                yield WarningResult("fixture_pause", "Paused before stale update")
                await asyncio.sleep(0.7)
                yield OperationResult(
                    operation_adapter.validate_python(
                        {
                            "op": "node.update",
                            "id": data["board"]["nodes"][0]["id"],
                            "set": {"label": "Stale model label"},
                        }
                    )
                )
                yield CompletedResult(1, 1)
                return
            async for result in real.generate(prepared, **kwargs):
                yield result
                if isinstance(result, OperationResult):
                    await asyncio.sleep(0.3)

    app.state.generation_service = Paused()


settings = Settings()
settings.server.allowed_origins = ["http://127.0.0.1:4194"]
app = create_app(settings, configure=configure)


@app.post("/_b4/api/v1/generations")
async def truncated(request: Request):
    data = await request.json()

    async def chunks():
        base = {
            "wireVersion": 1,
            "requestId": data["requestId"],
            "sessionEpoch": data["sessionEpoch"],
            "baseRevision": data["baseRevision"],
        }
        yield json.dumps({**base, "event": "started", "sequence": 1}) + "\n"
        section = data["idPrefix"] + "section"
        yield (
            json.dumps(
                {
                    **base,
                    "event": "operation",
                    "sequence": 2,
                    "operation": {"op": "section.add", "id": section, "title": "Retained"},
                }
            )
            + "\n"
        )
        yield (
            json.dumps(
                {
                    **base,
                    "event": "operation",
                    "sequence": 3,
                    "operation": {
                        "op": "node.add",
                        "id": data["idPrefix"] + "browser",
                        "section": section,
                        "type": "rect",
                        "label": "Retained Browser",
                    },
                }
            )
            + "\n"
        )
        await asyncio.sleep(0.1)
        yield '{"wireVersion":1,"event":"operation","operation":'

    return StreamingResponse(chunks(), media_type="application/x-ndjson")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8024, log_level="warning")
