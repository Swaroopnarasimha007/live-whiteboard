"""Incremental bounded SSE framing. No provider semantics or answer-text buffering here."""

import json
from dataclasses import dataclass

from app.contracts.interfaces import ProviderError


@dataclass(frozen=True)
class SSEEvent:
    name: str
    data: str


async def events(response, maximum=1048576):
    line = bytearray()
    data = []
    size = 0
    name = "message"
    async for chunk in response.aiter_bytes():
        pieces = chunk.split(b"\n")
        for index, piece in enumerate(pieces):
            line.extend(piece)
            if len(line) + size > maximum:
                raise ProviderError("invalid_output", "Provider event exceeds the transport limit.")
            if index == len(pieces) - 1:
                continue
            try:
                text = bytes(line).removesuffix(b"\r").decode("utf-8")
            except UnicodeDecodeError:
                raise ProviderError(
                    "stream_interrupted", "Provider sent invalid UTF-8 framing."
                ) from None
            line.clear()
            if not text:
                if data:
                    yield SSEEvent(name, "\n".join(data))
                name, data, size = "message", [], 0
            elif text.startswith("data:"):
                value = text[5:].removeprefix(" ")
                size += len(value.encode("utf-8")) + 1
                data.append(value)
            elif text.startswith("event:"):
                name = text[6:].strip()
            # Comments, IDs and reconnection hints never count as answer progress.
    if line or data:
        raise ProviderError("stream_interrupted", "Provider ended inside an SSE event.")


def object_data(event: SSEEvent) -> dict:
    try:
        value = json.loads(event.data)
        if not isinstance(value, dict):
            raise TypeError
        return value
    except (ValueError, TypeError):
        raise ProviderError("stream_interrupted", "Provider sent malformed event data.") from None
