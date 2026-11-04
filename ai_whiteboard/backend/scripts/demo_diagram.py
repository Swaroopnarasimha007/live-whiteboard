"""Explicit local mock diagram demo; no sessions, HTTP route, API keys or provider calls."""

import argparse
import asyncio
import json

from app.config import Settings
from app.diagram import (
    CompletedResult,
    DiagramRegistry,
    FailedResult,
    GenerationService,
    OperationResult,
    WarningResult,
)


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--text", default="The browser sends a request to the server, which queries the database"
    )
    parser.add_argument(
        "--fixture",
        choices=["request-flow", "delayed", "fragmented", "invalid", "error", "no-op"],
        default="delayed",
    )
    args = parser.parse_args()
    settings = Settings()
    settings.diagram.profiles["mock"].model = args.fixture
    registry = DiagramRegistry(settings)
    request = {
        "protocolVersion": 1,
        "requestId": "demo",
        "sessionId": "local_demo",
        "sessionEpoch": 1,
        "baseRevision": 0,
        "idPrefix": "g_demo_",
        "transcript": {"segmentIds": ["speech1"], "text": args.text, "startMs": 0, "endMs": 1000},
        "board": {
            "activeSectionId": None,
            "sections": [],
            "nodes": [],
            "edges": [],
            "viewport": {"x": 0, "y": 0, "scale": 1},
            "visibleWorldBounds": {"x": 0, "y": 0, "width": 1000, "height": 700},
            "selectedIds": [],
            "contextComplete": True,
            "omittedEntityCount": 0,
        },
    }
    try:
        service = GenerationService(registry)
        async for result in service.generate(service.prepare(request)):
            if isinstance(result, OperationResult):
                print(result.operation.model_dump_json(), flush=True)
            elif isinstance(result, WarningResult):
                print(json.dumps({"warning": result.code, "message": result.message}), flush=True)
            elif isinstance(result, CompletedResult):
                print(
                    json.dumps(
                        {
                            "completed": True,
                            "operations": result.operation_count,
                            "warnings": result.warning_count,
                        }
                    ),
                    flush=True,
                )
            elif isinstance(result, FailedResult):
                print(json.dumps({"failed": result.code, "message": result.message}), flush=True)
                raise SystemExit(1)
    finally:
        await registry.aclose()


if __name__ == "__main__":
    asyncio.run(main())
