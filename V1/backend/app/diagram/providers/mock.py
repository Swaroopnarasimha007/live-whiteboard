import asyncio
import json
import re

from app.contracts.interfaces import Finished, ProviderError, TextDelta, Usage


def operations(request):
    """Small deterministic, context-aware fixture planner; no replacement scene or layout."""
    data = json.loads(request.input_text)
    text = data["transcript"]["text"].lower()
    board, prefix = data["board"], data["idPrefix"]
    concepts = [
        (r"\bbrowser\b", "Browser"),
        (r"\b(?:api|server)\b", "Server"),
        (r"\bdatabase\b", "Database"),
        (r"\bcache\b", "Cache"),
        (r"\bqueue\b", "Queue"),
        (r"\bworker\b", "Worker"),
    ]
    found = [label for pattern, label in concepts if re.search(pattern, text)]
    if not found:
        return []
    result = []
    topic_change = bool(re.search(r"\b(?:new topic|switch topics|next topic)\b", text))
    section = None if topic_change else board["activeSectionId"]
    if section is None and not topic_change and board["sections"]:
        section = board["sections"][-1]["id"]
    if section is None:
        section = f"{prefix}section"
        result.append(
            {
                "op": "section.add",
                "id": section,
                "title": "Request flow" if not topic_change else "Next topic",
            }
        )
    nodes = {
        node["label"].lower(): node["id"] for node in board["nodes"] if node["sectionId"] == section
    }
    previous = None
    existing_edges = {(edge["from"], edge["to"]) for edge in board["edges"]}
    for label in found:
        identifier = nodes.get(label.lower(), f"{prefix}{label.lower()}")
        if label.lower() not in nodes:
            node = {
                "op": "node.add",
                "id": identifier,
                "section": section,
                "type": "rect",
                "label": label,
            }
            if previous:
                node["place"] = {"rightOf": previous}
            result.append(node)
        if previous and (previous, identifier) not in existing_edges:
            result.append(
                {
                    "op": "edge.add",
                    "id": f"{prefix}edge_{label.lower()}",
                    "section": section,
                    "from": previous,
                    "to": identifier,
                }
            )
        previous = identifier
    return result


class MockDiagramProvider:
    def __init__(self):
        self.closed = False

    async def stream(self, request):
        if self.closed:
            raise ProviderError("provider_unavailable", "Diagram provider is closed.")
        if request.model == "no-op":
            yield Finished("stop", effective_model=request.model, effective_provider="mock")
            return
        records = operations(request)
        yield Usage(None, None)
        for index, record in enumerate(records):
            if request.model == "delayed" and index:
                await asyncio.sleep(0.05)
            line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
            if request.model == "fragmented":
                for offset in range(0, len(line), 7):
                    yield TextDelta(line[offset : offset + 7])
                    await asyncio.sleep(0)
            else:
                yield TextDelta(line)
            if request.model == "invalid" and index == 0:
                yield TextDelta('{"op":"unsupported"}\n')
            if request.model == "error" and index == 0:
                raise ProviderError("stream_interrupted", "Mock provider interruption fixture.")
        yield Finished("stop", effective_model=request.model, effective_provider="mock")

    async def aclose(self):
        self.closed = True
