import asyncio

from anyio import CancelScope
from fastapi import APIRouter, Request, Response, WebSocket
from starlette.responses import StreamingResponse

from app.contracts import GenerationRequest, SessionCreate, SessionCreated, SessionOwner
from app.sessions import AudioBinding, SessionError
from app.speech.socket import AudioSocketService

router = APIRouter(prefix="/api/v1")


def registry(request):
    return request.app.state.session_registry


class EventResponse(StreamingResponse):
    def __init__(self, subscription):
        self.subscription = subscription
        super().__init__(
            subscription.events(),
            media_type="application/x-ndjson",
            headers={
                "Cache-Control": "no-cache, no-store, no-transform",
                "X-Accel-Buffering": "no",
            },
        )

    async def __call__(self, scope, receive, send):
        async def disconnected():
            while (await receive())["type"] != "http.disconnect":
                pass

        tasks = [
            asyncio.create_task(self.stream_response(send)),
            asyncio.create_task(disconnected()),
        ]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                try:
                    task.result()
                except OSError:
                    pass  # Client left; retain events and cancel after the cleanup window.
        finally:
            with CancelScope(shield=True):
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                await self.subscription.close()


def stream(subscription):
    return EventResponse(subscription)


@router.post("/sessions", response_model=SessionCreated, status_code=201)
async def create_session(body: SessionCreate, request: Request):
    return (await registry(request).create(body)).public()


@router.get("/sessions/{session_id}", response_model=SessionCreated)
async def read_session(session_id: str, sessionEpoch: int, request: Request):
    return (await registry(request).get(session_id, sessionEpoch)).public()


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str, sessionEpoch: int, request: Request):
    sessions = registry(request)
    try:
        session = await sessions.get(session_id, sessionEpoch)
    except SessionError as exc:
        if exc.status == 410:
            return Response(status_code=204)
        raise
    await sessions.delete(session)
    return Response(status_code=204)


@router.post("/sessions/{session_id}/reset", response_model=SessionCreated)
async def reset_session(session_id: str, body: SessionOwner, request: Request):
    if body.sessionId != session_id:
        raise SessionError(
            403, "session_mismatch", "Reset owner does not match the target session."
        )
    sessions = registry(request)
    session = await sessions.get(session_id, body.sessionEpoch)
    return await sessions.reset(session, body.sessionEpoch)


@router.post("/generations")
async def generate(body: GenerationRequest, request: Request):
    sessions = registry(request)
    session, record = await sessions.admit(body)
    return stream(await sessions.subscribe(session, record))


@router.post("/generations/{request_id}/cancel")
async def cancel_generation(request_id: str, body: SessionOwner, request: Request):
    sessions = registry(request)
    session = await sessions.get(body.sessionId, body.sessionEpoch)
    record = await sessions.retained(session, request_id)
    await sessions.cancel(session, record)
    return {"requestId": request_id, "sessionEpoch": session.epoch, "terminal": True}


@router.get("/generations/{request_id}/events")
async def replay(
    request_id: str, sessionId: str, sessionEpoch: int, request: Request, after: int = 0
):
    sessions = registry(request)
    session = await sessions.get(sessionId, sessionEpoch)
    record = await sessions.retained(session, request_id)
    return stream(await sessions.subscribe(session, record, after))


@router.websocket("/sessions/{session_id}/audio")
async def audio(websocket: WebSocket, session_id: str):
    sessions = websocket.app.state.session_registry
    try:
        session = await sessions.get(session_id)
    except SessionError:
        await websocket.close(code=1008, reason="Unknown or expired session. Reconnect first.")
        return
    async with session.condition:
        if session.audio_task:
            await websocket.close(code=1008, reason="A capture connection already exists.")
            return
        session.audio_task = asyncio.current_task()
    try:
        await AudioSocketService(sessions.speech).handle(
            websocket, AudioBinding(session, session.epoch)
        )
    finally:
        with CancelScope(shield=True):
            async with session.condition:
                if session.audio_task is asyncio.current_task():
                    session.audio_id = session.audio_task = None
