import asyncio
import hashlib
import json
import secrets
import time
from dataclasses import dataclass, field

from anyio import CancelScope

from app.contracts import SessionCreated, generation_event_adapter
from app.diagnostics import diagnostic
from app.diagram import (
    CompletedResult,
    FailedResult,
    GenerationState,
    OperationResult,
    WarningResult,
)
from app.speech import SpeechError

from .errors import SessionError

TERMINAL_RESERVE = 4096
MAX_IDENTITIES = 4096


@dataclass(eq=False)
class Record:
    request_id: str
    epoch: int
    base_revision: int
    fingerprint: str
    configuration_fingerprint: str
    lines: list[bytes] = field(default_factory=list)
    terminal: bool = False
    expires: float = float("inf")
    task: asyncio.Task | None = None
    subscribers: int = 0
    cursors: dict = field(default_factory=dict)
    operations: int = 0
    warnings: int = 0
    state: GenerationState = field(default_factory=GenerationState)


@dataclass(eq=False)
class Session:
    session_id: str
    epoch: int
    profile: str
    diagram_profile: str
    fingerprint: str
    touched: float
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    records: dict[str, Record] = field(default_factory=dict)
    used_requests: set[str] = field(default_factory=set)
    used_audio: set[str] = field(default_factory=set)
    active: Record | None = None
    audio_id: str | None = None
    audio_task: asyncio.Task | None = None
    bytes: int = 0
    closed: bool = False

    def public(self):
        return SessionCreated(
            sessionId=self.session_id,
            sessionEpoch=self.epoch,
            profile=self.profile,
            diagramProfile=self.diagram_profile,
            configurationFingerprint=self.fingerprint,
        )


class AudioBinding:
    def __init__(self, session, epoch):
        self.session, self.session_id, self.session_epoch, self.profile = (
            session,
            session.session_id,
            epoch,
            session.profile,
        )

    async def claim_audio(self, stream_id):
        session = self.session
        async with session.condition:
            if session.closed or session.epoch != self.session_epoch:
                raise SpeechError("stale_epoch", "Audio session is no longer current.")
            if session.audio_id or stream_id in session.used_audio:
                raise SpeechError(
                    "capture_conflict", "Stop the current capture and use a new audio stream ID."
                )
            if len(session.used_audio) >= MAX_IDENTITIES:
                raise SpeechError(
                    "overloaded",
                    "This session reached its stream limit. Reconnect with a new session.",
                )
            session.used_audio.add(stream_id)
            session.audio_id, session.audio_task = stream_id, asyncio.current_task()
            session.touched = time.monotonic()

    async def release_audio(self, stream_id):
        async with self.session.condition:
            if (
                self.session.audio_id == stream_id
                and self.session.audio_task is asyncio.current_task()
            ):
                self.session.audio_id = self.session.audio_task = None

    def audio_is_current(self, stream_id):
        session = self.session
        current = (
            not session.closed
            and session.epoch == self.session_epoch
            and session.audio_id == stream_id
        )
        if current:
            session.touched = time.monotonic()
        return current


class Subscription:
    def __init__(self, registry, session, record, after):
        self.registry, self.session, self.record = registry, session, record
        self.cursor, self.closed = after, False
        self.key = object()

    async def events(self):
        try:
            while True:
                async with self.session.condition:
                    while self.cursor >= len(self.record.lines) and not self.record.terminal:
                        await self.session.condition.wait()
                    if self.cursor < len(self.record.lines):
                        line = self.record.lines[self.cursor]
                        self.cursor += 1
                        self.record.cursors[self.key] = self.cursor
                        self.session.touched = time.monotonic()
                    else:
                        return
                yield line
        finally:
            await self.close()

    async def close(self):
        with CancelScope(shield=True):
            async with self.session.condition:
                if self.closed:
                    return
                self.closed = True
                self.record.subscribers -= 1
                self.record.cursors.pop(self.key, None)
                orphaned = self.record.subscribers == 0 and not self.record.terminal
        if orphaned:
            self.registry.background(self.registry.cancel_orphan(self.session, self.record))


class SessionRegistry:
    def __init__(self, settings, speech, diagram, service):
        self.settings = settings.model_copy(deep=True)
        self.speech, self.diagram, self.service = speech, diagram, service
        self.sessions = {}
        self.lock = asyncio.Lock()
        self.tasks = set()
        self.cancelled_tasks = set()
        self.closed = False

    def cancel_task(self, task):
        # Python 3.10 has no Task.cancelling(). Remember our cancellation requests
        # until completion so shutdown cannot interrupt cleanup from Stop/reset.
        if not task.done() and task not in self.cancelled_tasks:
            self.cancelled_tasks.add(task)
            task.add_done_callback(self.cancelled_tasks.discard)
            task.cancel()

    def background(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)

        def done(task):
            self.tasks.discard(task)
            if not task.cancelled():
                task.exception()

        task.add_done_callback(done)
        return task

    def expire_records(self, session):
        now = time.monotonic()
        for key, record in list(session.records.items()):
            if record.terminal and record.expires <= now and record.subscribers == 0:
                session.bytes -= sum(map(len, record.lines))
                del session.records[key]

    async def sweep(self):
        while not self.closed:
            await asyncio.sleep(min(5, self.settings.sessions.idle_ttl_seconds))
            now = time.monotonic()
            async with self.lock:
                stale = [
                    s
                    for s in self.sessions.values()
                    if now - s.touched >= self.settings.sessions.idle_ttl_seconds
                ]
                for session in stale:
                    self.sessions.pop(session.session_id, None)
            for session in stale:
                await self.close_session(session)
            for session in list(self.sessions.values()):
                async with session.condition:
                    self.expire_records(session)

    async def create(self, body):
        profile = self.speech.select_profile(body.profile)
        diagram = self.diagram.select_profile(body.diagramProfile)
        if body.sessionEpoch >= 9007199254740991:
            raise SessionError(409, "epoch_exhausted", "Create a session with a valid epoch.")
        async with self.lock:
            if self.closed:
                raise SessionError(503, "unavailable", "Session service is shutting down.")
            if len(self.sessions) >= self.settings.sessions.max_sessions:
                raise SessionError(
                    429,
                    "session_limit",
                    "Session capacity is full. Close another session or wait for it to expire.",
                )
            session = Session(
                "bs_" + secrets.token_urlsafe(24),
                body.sessionEpoch,
                profile,
                diagram,
                self.settings.fingerprint(),
                time.monotonic(),
            )
            self.sessions[session.session_id] = session
            diagnostic(
                "session.created",
                session_epoch=session.epoch,
                speech_profile=session.profile,
                diagram_profile=session.diagram_profile,
            )
        return session

    async def get(self, identifier, epoch=None):
        async with self.lock:
            session = self.sessions.get(identifier)
            if session is None or session.closed:
                raise SessionError(
                    410,
                    "session_expired",
                    "Backend session is unavailable. Reconnect to create a new session; keep the browser board.",
                )
            expired = time.monotonic() - session.touched >= self.settings.sessions.idle_ttl_seconds
            if expired:
                self.sessions.pop(identifier, None)
            elif epoch is not None and epoch != session.epoch:
                raise SessionError(
                    409,
                    "stale_epoch",
                    "Session epoch changed. Reconcile or create a new session before sending work.",
                )
            else:
                session.touched = time.monotonic()
        if expired:
            await self.close_session(session)
            raise SessionError(
                410,
                "session_expired",
                "Backend session expired. Reconnect while preserving the browser board.",
            )
        return session

    def persist(self, session, record, event, **values):
        if record.terminal:
            return False
        raw = {
            "wireVersion": 1,
            "requestId": record.request_id,
            "sessionEpoch": record.epoch,
            "sequence": len(record.lines) + 1,
            "event": event,
            **values,
        }
        line = (generation_event_adapter.validate_python(raw).model_dump_json() + "\n").encode(
            "utf-8"
        )
        terminal = event in ("completed", "failed", "cancelled")
        limit = self.settings.sessions.replay_max_bytes_per_session
        if session.bytes + len(line) > limit - (0 if terminal else TERMINAL_RESERVE):
            return False
        record.lines.append(line)
        if event != "operation":
            diagnostic(
                "generation.wire_event",
                warning=event in ("warning", "failed"),
                request_id=record.request_id,
                session_epoch=record.epoch,
                sequence=len(record.lines),
                wire_event=event,
                code=values.get("code"),
                operations=record.operations,
                warnings=record.warnings,
            )
        session.bytes += len(line)
        session.touched = time.monotonic()
        record.operations += event == "operation"
        record.warnings += event == "warning"
        if terminal:
            record.terminal = True
            record.expires = time.monotonic() + self.settings.sessions.replay_ttl_seconds
            if session.active is record:
                session.active = None
        session.condition.notify_all()
        return True

    async def admit(self, request):
        session = await self.get(request.sessionId, request.sessionEpoch)
        fingerprint = hashlib.sha256(
            json.dumps(
                request.model_dump(mode="json"),
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode()
        ).hexdigest()
        async with session.condition:
            if session.closed or session.epoch != request.sessionEpoch:
                raise SessionError(409, "stale_epoch", "Session changed before generation started.")
            self.expire_records(session)
            old = session.records.get(request.requestId)
            if old:
                if old.terminal and old.expires <= time.monotonic():
                    raise SessionError(
                        410,
                        "replay_expired",
                        "Retained request expired. Use a new ID and fresh context.",
                    )
                if old.fingerprint != fingerprint:
                    raise SessionError(
                        409,
                        "request_conflict",
                        "Request ID was already used with different content.",
                    )
                diagnostic(
                    "generation.replay_duplicate",
                    request_id=old.request_id,
                    session_epoch=old.epoch,
                    events=len(old.lines),
                    terminal=old.terminal,
                )
                return session, old
            if request.requestId in session.used_requests:
                raise SessionError(
                    410,
                    "replay_expired",
                    "Retained request expired. Use a new request ID and fresh context; output will not be regenerated.",
                )
            if session.active:
                raise SessionError(
                    409,
                    "generation_busy",
                    "A generation request is already active in this session.",
                )
            if len(session.used_requests) >= MAX_IDENTITIES:
                raise SessionError(
                    429,
                    "request_limit",
                    "Session request limit reached. Create a new session while keeping the board.",
                )
            prepared = self.service.prepare(request, profile=session.diagram_profile)
            if (
                session.bytes + TERMINAL_RESERVE + 1024
                > self.settings.sessions.replay_max_bytes_per_session
            ):
                raise SessionError(
                    507,
                    "replay_capacity",
                    "Replay retention is full. Wait for retained records to expire or reconnect with a new session.",
                )
            record = Record(
                request.requestId,
                request.sessionEpoch,
                request.baseRevision,
                fingerprint,
                prepared.configuration_fingerprint,
            )
            session.records[record.request_id] = record
            session.used_requests.add(record.request_id)
            session.active = record
            self.persist(session, record, "started", baseRevision=record.base_revision)
            record.task = self.background(self.produce(session, record, prepared))
            return session, record

    async def produce(self, session, record, prepared):
        iterator = self.service.generate(prepared, state=record.state)
        try:
            async for result in iterator:
                async with session.condition:
                    if record.terminal:
                        break
                    if session.closed or session.epoch != record.epoch:
                        self.persist(session, record, "cancelled", reason="Session changed")
                        break
                    if (
                        record.cursors
                        and max(len(record.lines) - cursor for cursor in record.cursors.values())
                        >= self.settings.sessions.max_pending_events
                    ):
                        self.persist(
                            session,
                            record,
                            "failed",
                            code="overloaded",
                            message="Event consumer is too slow. Validated events remain available for replay.",
                            retryable=False,
                        )
                        break
                    if isinstance(result, OperationResult):
                        ok = self.persist(
                            session,
                            record,
                            "operation",
                            baseRevision=record.base_revision,
                            operation=result.operation,
                        )
                    elif isinstance(result, WarningResult):
                        ok = self.persist(
                            session,
                            record,
                            "warning",
                            code=result.code[:64],
                            message=result.message[:500],
                        )
                    elif isinstance(result, CompletedResult):
                        ok = self.persist(
                            session,
                            record,
                            "completed",
                            operationCount=record.operations,
                            warningCount=record.warnings,
                        )
                    elif isinstance(result, FailedResult):
                        ok = self.persist(
                            session,
                            record,
                            "failed",
                            code=result.code[:64],
                            message=result.message[:500],
                            retryable=result.retryable,
                        )
                    else:
                        raise TypeError("Unknown generation result")
                    if not ok:
                        self.persist(
                            session,
                            record,
                            "failed",
                            code="replay_capacity",
                            message="Replay retention limit reached. Earlier validated events are retained.",
                            retryable=False,
                        )
                        break
        except asyncio.CancelledError:
            async with session.condition:
                self.persist(session, record, "cancelled", reason="Generation cancelled")
            raise
        except Exception as exc:  # noqa: BLE001 -- Never expose provider/session internals after response headers.
            diagnostic(
                "generation.producer_exception",
                warning=True,
                request_id=record.request_id,
                error_type=type(exc).__name__,
            )
            async with session.condition:
                self.persist(
                    session,
                    record,
                    "failed",
                    code="stream_interrupted",
                    message="Generation was interrupted. Earlier validated events are retained.",
                    retryable=False,
                )
        finally:
            await iterator.aclose()
            async with session.condition:
                if not record.terminal:
                    self.persist(
                        session,
                        record,
                        "failed",
                        code="stream_interrupted",
                        message="Producer ended without a terminal result.",
                        retryable=False,
                    )

    async def subscribe(self, session, record, after=0):
        async with session.condition:
            if session.closed or record.epoch != session.epoch:
                raise SessionError(409, "stale_epoch", "Session changed before streaming started.")
            if after < 0 or after > len(record.lines):
                raise SessionError(
                    409, "invalid_cursor", "Replay cursor exceeds retained sequence numbers."
                )
            if record.subscribers >= 4:
                raise SessionError(429, "subscriber_limit", "Too many readers for this request.")
            subscription = Subscription(self, session, record, after)
            record.subscribers += 1
            record.cursors[subscription.key] = after
            return subscription

    async def retained(self, session, request_id):
        async with session.condition:
            self.expire_records(session)
            record = session.records.get(request_id)
            if record is None:
                raise SessionError(
                    410,
                    "replay_expired",
                    "Replay is unknown or expired. Start a new request with fresh context.",
                )
            if record.terminal and record.expires <= time.monotonic():
                raise SessionError(
                    410, "replay_expired", "Replay expired. Start a new request with fresh context."
                )
            if record.epoch != session.epoch:
                raise SessionError(
                    409, "stale_epoch", "Replay belongs to an obsolete session epoch."
                )
            return record

    async def cancel_orphan(self, session, record):
        await asyncio.sleep(0.1)
        await self.cancel(session, record, "Client disconnected", only_if_orphan=True)

    async def cancel(
        self, session, record, reason="User stopped generation", *, only_if_orphan=False
    ):
        async with session.condition:
            if only_if_orphan and record.subscribers:
                return
            cancelled = self.persist(session, record, "cancelled", reason=reason)
            task = record.task
        # A terminal record may still be closing its provider. Repeated cancellation
        # must not inject another CancelledError into that cleanup.
        if cancelled and task and not task.done():
            self.cancel_task(task)
            await asyncio.wait([task], timeout=1.5)

    async def reset(self, session, epoch):
        async with session.condition:
            if session.epoch != epoch or session.closed:
                raise SessionError(409, "stale_epoch", "Session changed before reset.")
            if epoch >= 9007199254740990:
                raise SessionError(409, "epoch_exhausted", "Create a fresh backend session.")
            record, audio = session.active, session.audio_task
            if record:
                self.persist(session, record, "cancelled", reason="Session reset")
            session.epoch += 1
            session.audio_id = session.audio_task = None
            session.touched = time.monotonic()
        tasks = [
            task for task in (record.task if record else None, audio) if task and not task.done()
        ]
        for task in tasks:
            self.cancel_task(task)
        if tasks:
            await asyncio.wait(tasks, timeout=1.5)
        return session.public()

    async def close_session(self, session):
        async with session.condition:
            session.closed = True
            record, audio = session.active, session.audio_task
            if record:
                self.persist(session, record, "cancelled", reason="Session closed")
            session.audio_id = session.audio_task = None
        tasks = [
            task for task in (record.task if record else None, audio) if task and not task.done()
        ]
        for task in tasks:
            self.cancel_task(task)
        if tasks:
            await asyncio.wait(tasks, timeout=1.5)

    async def delete(self, session):
        async with self.lock:
            self.sessions.pop(session.session_id, None)
        await self.close_session(session)

    async def aclose(self):
        self.closed = True
        for session in list(self.sessions.values()):
            await self.close_session(session)
        self.sessions.clear()
        tasks = [
            task for task in self.tasks if task is not asyncio.current_task() and not task.done()
        ]
        for task in tasks:
            self.cancel_task(task)
        if tasks:
            await asyncio.wait(tasks, timeout=2)
