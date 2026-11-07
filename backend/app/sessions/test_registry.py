import asyncio
import json
import time

import pytest

from app.api.test_routes import generation
from app.config import Settings
from app.contracts import GenerationRequest, SessionCreate
from app.contracts.operations import operation_adapter
from app.diagram import CompletedResult, DiagramRegistry, GenerationService, OperationResult
from app.sessions import SessionError, SessionRegistry
from app.speech import SpeechRegistry


class GateService:
    def __init__(self, real):
        self.real, self.calls, self.closed = real, 0, 0
        self.gate = asyncio.Event()

    def prepare(self, request, profile):
        return self.real.prepare(request, profile)

    async def generate(self, prepared, state):
        self.calls += 1
        try:
            yield OperationResult(
                operation_adapter.validate_json(
                    '{"op":"section.add","id":"g_r1_first","title":"First"}'
                )
            )
            await self.gate.wait()
            yield CompletedResult(1, 0)
        finally:
            self.closed += 1


async def setup():
    settings = Settings()
    speech, diagram = SpeechRegistry(settings), DiagramRegistry(settings)
    service = GateService(GenerationService(diagram))
    sessions = SessionRegistry(settings, speech, diagram, service)
    session = await sessions.create(SessionCreate())
    return sessions, session, service, speech, diagram


async def cleanup(sessions, speech, diagram):
    await sessions.aclose()
    await speech.aclose()
    await diagram.aclose()


def test_atomic_replay_tail_and_one_active_request():
    async def run():
        sessions, session, service, speech, diagram = await setup()
        body = GenerationRequest.model_validate_json(
            json.dumps(generation(session.public().model_dump()))
        )
        _, record = await sessions.admit(body)
        first = await sessions.subscribe(session, record)
        iterator = first.events()
        assert json.loads(await anext(iterator))["event"] == "started"
        assert json.loads(await anext(iterator))["sequence"] == 2
        _same_session, same_record = await sessions.admit(body)
        assert same_record is record and service.calls == 1
        second = body.model_copy(update={"requestId": "r2", "idPrefix": "g_r2_"})
        with pytest.raises(SessionError) as error:
            await sessions.admit(second)
        assert error.value.status == 409
        replay = await sessions.subscribe(session, record, 1)
        service.gate.set()
        replayed = [json.loads(line) async for line in replay.events()]
        assert [e["sequence"] for e in replayed] == [2, 3]
        assert replayed[-1]["event"] == "completed"
        assert json.loads(await anext(iterator))["event"] == "completed"
        await iterator.aclose()
        assert record.subscribers == 0 and service.calls == 1
        await cleanup(sessions, speech, diagram)

    asyncio.run(run())


@pytest.mark.parametrize("limit", ["slow_reader", "retention"])
def test_bounded_logs_always_retain_a_terminal_and_close_the_producer(limit):
    async def run():
        sessions, session, service, speech, diagram = await setup()

        class ManyResults:
            closed = False

            def prepare(self, *args, **kwargs):
                return service.prepare(*args, **kwargs)

            async def generate(self, prepared, state):
                try:
                    for index in range(20):
                        yield OperationResult(
                            operation_adapter.validate_python(
                                {"op": "section.add", "id": f"g_r1_s{index}", "title": "x" * 120}
                            )
                        )
                finally:
                    self.closed = True

        producer = ManyResults()
        sessions.service = producer
        if limit == "slow_reader":
            sessions.settings.sessions.max_pending_events = 1
        else:
            sessions.settings.sessions.replay_max_bytes_per_session = 6000
        body = GenerationRequest.model_validate(generation(session.public().model_dump()))
        _, record = await sessions.admit(body)
        subscription = await sessions.subscribe(session, record)
        await record.task
        events = [json.loads(line) async for line in subscription.events()]
        assert events[-1]["event"] == "failed"
        assert events[-1]["code"] == ("overloaded" if limit == "slow_reader" else "replay_capacity")
        assert producer.closed and session.active is None
        assert session.bytes <= sessions.settings.sessions.replay_max_bytes_per_session
        assert [event["sequence"] for event in events] == list(range(1, len(events) + 1))
        await cleanup(sessions, speech, diagram)

    asyncio.run(run())


def test_audio_binding_rejects_old_epochs_and_used_stream_ids():
    from app.sessions import AudioBinding
    from app.speech import SpeechError

    async def run():
        sessions, session, _service, speech, diagram = await setup()
        binding = AudioBinding(session, 0)
        await binding.claim_audio("a1")
        assert binding.audio_is_current("a1")
        await binding.release_audio("a1")
        with pytest.raises(SpeechError):
            await binding.claim_audio("a1")
        await sessions.reset(session, 0)
        with pytest.raises(SpeechError):
            await binding.claim_audio("a2")
        assert not binding.audio_is_current("a1")
        await cleanup(sessions, speech, diagram)

    asyncio.run(run())


def test_disconnect_cancels_and_replay_never_regenerates():
    async def run():
        sessions, session, service, speech, diagram = await setup()
        body = GenerationRequest.model_validate_json(
            json.dumps(generation(session.public().model_dump()))
        )
        _, record = await sessions.admit(body)
        sub = await sessions.subscribe(session, record)
        iterator = sub.events()
        await anext(iterator)
        await anext(iterator)
        await iterator.aclose()
        await asyncio.sleep(0.15)
        assert record.terminal and json.loads(record.lines[-1])["event"] == "cancelled"
        assert service.closed == 1
        _, same = await sessions.admit(body)
        assert same is record and service.calls == 1
        record.expires = time.monotonic() - 1
        with pytest.raises(SessionError) as error:
            await sessions.admit(body)
        assert error.value.status == 410 and service.calls == 1
        await cleanup(sessions, speech, diagram)

    asyncio.run(run())


def test_reset_invalidates_old_records_and_idle_expiry_is_explicit():
    async def run():
        sessions, session, service, speech, diagram = await setup()
        body = GenerationRequest.model_validate_json(
            json.dumps(generation(session.public().model_dump()))
        )
        await sessions.admit(body)
        await asyncio.sleep(0)
        result = await sessions.reset(session, 0)
        assert result.sessionEpoch == 1 and service.closed == 1
        with pytest.raises(SessionError):
            await sessions.retained(session, "r1")
        session.touched = time.monotonic() - 1000
        with pytest.raises(SessionError) as error:
            await sessions.get(session.session_id)
        assert error.value.status == 410
        await cleanup(sessions, speech, diagram)

    asyncio.run(run())


@pytest.mark.parametrize("action", ["cancel", "reset", "delete", "shutdown"])
def test_repeated_cancel_does_not_interrupt_provider_cleanup(action):
    async def run():
        sessions, session, service, speech, diagram = await setup()
        closing, release, closed = asyncio.Event(), asyncio.Event(), asyncio.Event()

        class SlowCleanup:
            def prepare(self, *args, **kwargs):
                return service.prepare(*args, **kwargs)

            async def generate(self, prepared, state):
                try:
                    await asyncio.Event().wait()
                    yield CompletedResult(0, 0)
                finally:
                    closing.set()
                    await release.wait()
                    closed.set()

        sessions.service = SlowCleanup()
        body = GenerationRequest.model_validate(generation(session.public().model_dump()))
        _, record = await sessions.admit(body)
        await asyncio.sleep(0)
        first = asyncio.create_task(sessions.cancel(session, record))
        await closing.wait()
        followup = {
            "cancel": lambda: sessions.cancel(session, record),
            "reset": lambda: sessions.reset(session, 0),
            "delete": lambda: sessions.delete(session),
            "shutdown": sessions.aclose,
        }
        second = asyncio.create_task(followup[action]())
        await asyncio.sleep(0)
        release.set()
        await asyncio.gather(first, second)
        assert closed.is_set()
        await asyncio.sleep(0)
        assert not sessions.cancelled_tasks
        assert [json.loads(line)["event"] for line in record.lines] == ["started", "cancelled"]
        await cleanup(sessions, speech, diagram)

    asyncio.run(run())
