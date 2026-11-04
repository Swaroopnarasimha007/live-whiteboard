"""Metadata-only diagnostics; never pass prompts, bodies, credentials or audio here."""

import json
import logging


def diagnostic(event, *, warning=False, **fields):
    logger = logging.getLogger("whiteboard")
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s [whiteboard.backend] %(message)s"))
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    logger.log(logging.WARNING if warning else logging.INFO, json.dumps({"event": event, **fields}))


def schema_issues(error):
    allowed = {
        "op",
        "id",
        "section",
        "type",
        "label",
        "color",
        "at",
        "place",
        "rightOf",
        "leftOf",
        "above",
        "below",
        "set",
        "kind",
        "from",
        "to",
        "title",
        "node.add",
        "edge.add",
        "section.add",
        "node.update",
        "edge.update",
        "entity.delete",
    }
    return [
        {
            "path": ".".join(
                str(part) if isinstance(part, int) or part in allowed else "[field]"
                for part in item["loc"]
            ),
            "type": item["type"],
        }
        for item in error.errors(include_input=False, include_context=False, include_url=False)[:20]
    ]
