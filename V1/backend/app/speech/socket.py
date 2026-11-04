"""B1 audio socket service. B3 resolves/authorizes sessions and mounts this service."""

import asyncio
from typing import Protocol

from anyio import CancelScope
from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.contracts.audio import (
    AudioStart,
    SpeechStreamConfig,
    audio_client_adapter,
    validate_pcm_frame,
)

from .errors import SpeechError


class AudioSession(Protocol):
    session_id: str
    session_epoch: int
    profile: str

    async def claim_audio(self, stream_id: str) -> None:
        """Reject concurrent/reused stream IDs and bind capture to this session epoch."""
        ...

    async def release_audio(self, stream_id: str) -> None: ...
    def audio_is_current(self, stream_id: str) -> bool: ...


class AbortCapture(Exception):
    pass


class AudioSocketService:
    def __init__(self, registry):
        self.registry = registry
        self.settings = registry.settings

    async def handle(self, websocket: WebSocket, session: AudioSession):
        if websocket.headers.get("origin") not in self.settings.server.allowed_origins:
            await websocket.close(code=1008)
            return
        await websocket.accept()
        stream = start = None
        claimed = False
        tasks = []
        disconnected = False

        async def send(event):
            await asyncio.wait_for(websocket.send_json(event), timeout=5)

        def current():
            if not session.audio_is_current(start.streamId):
                raise SpeechError(
                    "stale_epoch", "Capture belongs to an inactive session or stream."
                )

        async def stop_tasks():
            for task in tasks:
                if not task.done():
                    task.cancel()
            # Native recognition may be noninterruptible. Its worker retains ownership.
            if tasks:
                _, pending = await asyncio.wait(tasks, timeout=0.25)
                for task in pending:
                    task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
                for task in tasks:
                    if task.done() and not task.cancelled():
                        task.exception()

        try:
            message = await asyncio.wait_for(websocket.receive(), timeout=10)
            text = message.get("text")
            if text is None or len(text.encode("utf-8")) > 4096:
                raise SpeechError("invalid_start", "Send a bounded audio start message first.")
            start = audio_client_adapter.validate_json(text)
            if not isinstance(start, AudioStart):
                start = None
                raise SpeechError("invalid_start", "Audio start must be the first message.")
            if start.sessionEpoch != session.session_epoch or start.profile != session.profile:
                raise SpeechError(
                    "stale_epoch",
                    "Audio profile/epoch does not match this session. Start a new capture to switch profiles.",
                )
            await session.claim_audio(start.streamId)
            claimed = True
            config = self.settings.transcription
            stream_config = SpeechStreamConfig(
                streamId=start.streamId,
                sessionEpoch=start.sessionEpoch,
                profile=start.profile,
                format=start.format,
                maxBufferMs=config.audio.max_buffer_ms,
                partialEmitIntervalMs=config.endpointing.partial_emit_interval_ms,
                maxSegmentMs=config.endpointing.max_segment_ms,
            )
            stream = await self.registry.open_stream(stream_config)
            current()
            await send(
                {
                    "type": "ready",
                    "streamId": start.streamId,
                    "sessionEpoch": start.sessionEpoch,
                    "profile": start.profile,
                    "format": start.format.model_dump(),
                }
            )
            queue = asyncio.Queue(
                maxsize=max(
                    self.settings.sessions.max_pending_events,
                    config.audio.max_buffer_ms // config.audio.frame_ms + 1,
                )
            )
            queued_bytes = 0
            byte_limit = config.audio.max_buffer_ms * start.format.sampleRateHz * 2 // 1000

            async def receive():
                nonlocal queued_bytes, disconnected
                while True:
                    message = await websocket.receive()
                    if message["type"] == "websocket.disconnect":
                        disconnected = True
                        raise WebSocketDisconnect(message.get("code", 1000))
                    current()
                    frame = message.get("bytes")
                    if frame is not None:
                        try:
                            validate_pcm_frame(frame, start.format)
                        except ValueError:
                            raise SpeechError(
                                "invalid_audio",
                                "PCM frames must be aligned and at most one second.",
                            ) from None
                        if queued_bytes + len(frame) > byte_limit or queue.full():
                            raise SpeechError(
                                "overloaded",
                                "Audio buffer is full. Capture was interrupted; restart to continue.",
                            )
                        queued_bytes += len(frame)
                        queue.put_nowait(frame)
                    else:
                        text = message.get("text", "")
                        if len(text.encode("utf-8")) > 4096:
                            raise SpeechError(
                                "invalid_control", "Audio control message is too large."
                            )
                        control = audio_client_adapter.validate_json(text)
                        if isinstance(control, AudioStart):
                            raise SpeechError(
                                "invalid_control", "Profile changes need a new capture connection."
                            )
                        if control.type == "abort":
                            raise AbortCapture()
                        await queue.put(None)
                        return

            async def process():
                nonlocal queued_bytes
                samples = 0
                while True:
                    frame = await queue.get()
                    if frame is None:
                        await stream.finish()
                        return
                    try:
                        current()
                        await stream.push_audio(frame)
                        samples += len(frame) // 2
                        await send(
                            {
                                "type": "processed",
                                "streamId": start.streamId,
                                "sessionEpoch": start.sessionEpoch,
                                "samples": samples,
                            }
                        )
                    finally:
                        queued_bytes -= len(frame)

            async def publish():
                async for event in stream.events():
                    current()
                    await send(event.model_dump())

            tasks = [asyncio.create_task(fn()) for fn in (receive, process, publish)]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
            for task in done:
                task.result()
            # The close acknowledgement authorizes the next hold to start.
            await session.release_audio(start.streamId)
            claimed = False
            await send(
                {
                    "type": "closed",
                    "streamId": start.streamId,
                    "sessionEpoch": start.sessionEpoch,
                    "reason": "finished",
                }
            )
        except AbortCapture:
            await stream.close()
            await stop_tasks()
            await session.release_audio(start.streamId)
            claimed = False
            # Stop may close the browser socket immediately after sending abort.
            # This acknowledgement is best effort, just like error termination.
            try:
                await send(
                    {
                        "type": "closed",
                        "streamId": start.streamId,
                        "sessionEpoch": start.sessionEpoch,
                        "reason": "aborted",
                    }
                )
            except (WebSocketDisconnect, OSError, RuntimeError, asyncio.TimeoutError):
                disconnected = True
        except (WebSocketDisconnect, OSError):
            disconnected = True
        except (SpeechError, ValidationError, TimeoutError, asyncio.TimeoutError) as exc:
            if stream:
                await stream.close()
            await stop_tasks()
            if isinstance(exc, SpeechError):
                code, message = exc.code, exc.message
            else:
                code, message = (
                    "invalid_audio_protocol",
                    "Audio handshake/control is invalid or timed out.",
                )
            if start is not None and not disconnected:
                try:
                    base = {"streamId": start.streamId, "sessionEpoch": start.sessionEpoch}
                    await send({**base, "type": "error", "code": code, "message": message})
                    await send({**base, "type": "closed", "reason": "error"})
                except (WebSocketDisconnect, OSError, RuntimeError, asyncio.TimeoutError):
                    disconnected = True
        finally:
            # ASGI disconnect/unmount can cancel the handler while cleanup is awaiting.
            with CancelScope(shield=True):
                try:
                    if stream:
                        await stream.close()
                    await stop_tasks()
                finally:
                    if claimed:
                        await session.release_audio(start.streamId)
                    if not disconnected:
                        try:
                            await websocket.close(code=1000 if start else 1008)
                        except (WebSocketDisconnect, OSError, RuntimeError):
                            pass
