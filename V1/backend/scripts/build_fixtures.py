"""Deterministic cross-language fixtures. They exercise runtime semantics as well as structure."""

import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "shared/protocol/v1"


def changed(value, path, replacement):
    result = copy.deepcopy(value)
    target = result
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = replacement
    return result


def main():
    section = {
        "id": "g_s1",
        "title": "Request flow",
        "origin": {"x": 100, "y": 200},
        "bounds": {"x": 0, "y": 0, "width": 900, "height": 600},
    }
    node = {
        "id": "g_old_browser",
        "sectionId": "g_s1",
        "type": "rect",
        "label": "Browser",
        "color": "blue",
        "x": 32,
        "y": 48,
        "width": 120,
        "height": 64,
        "source": "generated",
        "locked": False,
        "revision": 1,
    }
    second = {
        **node,
        "id": "m_00000000-0000-4000-8000-000000000001",
        "label": "Database",
        "x": 400,
        "source": "manual",
        "locked": True,
        "revision": 12,
    }
    edge = {
        "id": "g_old_edge",
        "sectionId": "g_s1",
        "from": node["id"],
        "to": second["id"],
        "kind": "arrow",
        "label": "queries",
        "color": "neutral",
        "source": "generated",
        "locked": True,
        "revision": 10,
    }
    request = {
        "protocolVersion": 1,
        "requestId": "r1",
        "sessionId": "s1",
        "sessionEpoch": 1,
        "baseRevision": 12,
        "idPrefix": "g_r1_",
        "transcript": {
            "segmentIds": ["a1_7"],
            "text": "The browser queries the database",
            "startMs": 1400,
            "endMs": 2900,
        },
        "board": {
            "activeSectionId": "g_s1",
            "sections": [section],
            "nodes": [node, second],
            "edges": [edge],
            "viewport": {"x": 17, "y": -20, "scale": 1.5},
            "visibleWorldBounds": {"x": 0, "y": 0, "width": 900, "height": 600},
            "selectedIds": [second["id"]],
            "contextComplete": True,
            "omittedEntityCount": 0,
        },
    }
    operations = [
        {"op": "section.add", "id": "g_r1_topic", "title": "Server"},
        {
            "op": "node.add",
            "id": "g_r1_server",
            "section": "g_s1",
            "type": "roundRect",
            "label": "Server",
            "place": {"rightOf": node["id"]},
        },
        {
            "op": "edge.add",
            "id": "g_r1_link",
            "section": "g_s1",
            "from": node["id"],
            "to": "g_r1_server",
        },
        {"op": "node.update", "id": "g_r1_server", "set": {"at": [200, -20], "label": "API"}},
        {"op": "edge.update", "id": "g_r1_link", "set": {"label": ""}},
        {"op": "entity.delete", "id": "g_r1_link"},
    ]
    base = {"wireVersion": 1, "requestId": "r1", "sessionEpoch": 1}
    events = [
        {**base, "event": "started", "sequence": 1, "baseRevision": 12},
        {
            **base,
            "event": "operation",
            "sequence": 2,
            "baseRevision": 12,
            "operation": operations[1],
        },
        {
            **base,
            "event": "warning",
            "sequence": 3,
            "code": "invalid_output",
            "message": "Rejected invalid record.",
        },
        {**base, "event": "completed", "sequence": 4, "operationCount": 1, "warningCount": 1},
        {
            **base,
            "event": "failed",
            "sequence": 4,
            "code": "stream_interrupted",
            "message": "Provider interrupted.",
            "retryable": False,
        },
        {**base, "event": "cancelled", "sequence": 4, "reason": "User stopped"},
    ]
    audio_base = {"streamId": "a1", "sessionEpoch": 1}
    fmt = {"encoding": "pcm_s16le", "sampleRateHz": 16000, "channels": 1}
    audio_start = {
        **audio_base,
        "type": "start",
        "audioProtocolVersion": 1,
        "profile": "mock",
        "format": fmt,
    }
    audio_events = [
        {**audio_base, "type": "ready", "profile": "mock", "format": fmt},
        {
            **audio_base,
            "type": "transcript",
            "id": "a1_7",
            "text": "Hello",
            "startMs": 0,
            "endMs": 100,
            "isFinal": False,
        },
        {
            **audio_base,
            "type": "transcript",
            "id": "a1_7",
            "text": "Hello world",
            "startMs": 0,
            "endMs": 200,
            "isFinal": True,
        },
        {**audio_base, "type": "error", "code": "overloaded", "message": "Capture paused"},
        {**audio_base, "type": "closed", "reason": "finished"},
    ]
    missing_protection = copy.deepcopy(request)
    del missing_protection["board"]["edges"][0]["locked"]
    fixtures = {
        "operation": {
            "valid": operations,
            "invalid": [
                {**operations[0], "id": "__proto__"},
                {**operations[1], "label": " "},
                {**operations[1], "at": [0, 0]},
                {**operations[1], "place": {"rightOf": "g_a", "below": "g_b"}},
                {**operations[3], "set": {}},
                {**operations[4], "set": {"color": None}},
                {**operations[1], "type": "svg"},
                {**operations[1], "extra": 1},
                {**operations[3], "set": {"at": [100001, 0]}},
            ],
        },
        "generation-request": {
            "valid": [request],
            "invalid": [
                missing_protection,
                changed(request, ["board", "contextComplete"], False),
                changed(request, ["board", "edges", 0, "revision"], 13),
                changed(request, ["board", "edges", 0, "from"], "g_missing"),
                changed(request, ["board", "nodes", 0, "source"], "manual"),
                changed(request, ["board", "nodes", 0, "type"], "circle"),
                changed(request, ["transcript", "endMs"], 0),
                changed(request, ["transcript", "segmentIds"], ["a1", "a1"]),
                changed(request, ["board", "selectedIds"], ["g_missing"]),
                changed(request, ["protocolVersion"], 2),
                changed(request, ["protocolVersion"], True),
                changed(request, ["board", "contextComplete"], 1),
            ],
        },
        "generation-event": {
            "valid": events,
            "invalid": [
                {**events[0], "sequence": 0},
                {**events[1], "wireVersion": 2},
                {**events[3], "operationCount": -1},
                {**events[0], "extra": 1},
            ],
        },
        "audio-client-message": {
            "valid": [audio_start, {"type": "finish"}, {"type": "abort"}],
            "invalid": [
                changed(audio_start, ["format", "sampleRateHz"], 48000),
                changed(audio_start, ["format", "channels"], 2),
                {**audio_start, "audioProtocolVersion": 2},
                {"type": "finish", "audio": "not-pcm"},
            ],
        },
        "audio-server-event": {
            "valid": audio_events,
            "invalid": [
                {**audio_events[1], "endMs": -1},
                {**audio_events[2], "isFinal": "true"},
                {**audio_events[0], "extra": 1},
            ],
        },
    }
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / "fixtures.json").write_text(
        json.dumps(fixtures, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
