import asyncio
from collections import deque
from concurrent.futures import ThreadPoolExecutor

from app.contracts.audio import AudioProgress, validate_pcm_frame

from .errors import SpeechError


class WorkerSpeechStream:
    """One dedicated ordered worker per recognizer; no native calls on the event loop."""

    def __init__(self, config, engine_factory, release, max_events=256):
        self.config, self.engine_factory, self.release = config, engine_factory, release
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="speech")
        self.engine = None
        self.lock = asyncio.Lock()
        self.pending_bytes = 0
        self.queue = deque()
        self.max_events = max_events
        self.changed = asyncio.Event()
        self.ended = self.aborted = self.consumer = self.finishing = False
        self.cleanup = None
        self.loop = asyncio.get_running_loop()

    def progress(self, stage):
        event = AudioProgress(
            streamId=self.config.streamId, sessionEpoch=self.config.sessionEpoch, stage=stage
        )
        self.loop.call_soon_threadsafe(self._publish, [event])

    async def _run(self, callback):
        future = asyncio.get_running_loop().run_in_executor(self.executor, callback)
        try:
            return await asyncio.shield(future)
        except asyncio.CancelledError:
            # Keep this stream's lock/slot until the non-interruptible native call returns.
            self.aborted = self.ended = True
            self.queue.clear()
            self.changed.set()
            try:
                await asyncio.shield(future)
            finally:
                self._cleanup()
            raise
        except SpeechError:
            raise
        except Exception:  # noqa: BLE001 -- Normalize all vendor/native recognition errors.
            raise SpeechError(
                "recognition_failed", "Speech recognition failed. Stop capture and retry."
            ) from None

    async def initialize(self):
        def initialize():
            self.engine = self.engine_factory()

        async with self.lock:
            await self._run(initialize)

    def _publish(self, events):
        if self.aborted:
            return
        if len(self.queue) + len(events) > self.max_events:
            raise SpeechError(
                "overloaded", "Transcript consumer is too slow. Capture was interrupted."
            )
        self.queue.extend(events)
        self.changed.set()

    async def push_audio(self, frame: bytes):
        try:
            validate_pcm_frame(frame, self.config.format)
        except ValueError:
            raise SpeechError(
                "invalid_audio", "Expected aligned mono 16 kHz PCM frames of at most one second."
            ) from None
        if self.ended or self.finishing:
            raise SpeechError("closed", "Audio stream is no longer accepting frames.")
        limit = self.config.maxBufferMs * self.config.format.sampleRateHz * 2 // 1000
        if self.pending_bytes + len(frame) > limit:
            raise SpeechError(
                "overloaded", "Audio processing buffer is full. Capture was interrupted."
            )
        self.pending_bytes += len(frame)
        try:
            async with self.lock:
                if self.ended:
                    raise SpeechError("closed", "Audio stream is closed.")
                self._publish(await self._run(lambda: self.engine.push(frame)))
        except BaseException:
            await self.close()
            raise
        finally:
            self.pending_bytes -= len(frame)

    async def events(self):
        if self.consumer:
            raise SpeechError("consumer_conflict", "Only one transcript consumer is allowed.")
        self.consumer = True
        while True:
            while self.queue:
                yield self.queue.popleft()
            if self.ended:
                return
            self.changed.clear()
            await self.changed.wait()

    async def finish(self):
        if self.ended or self.finishing:
            return
        self.finishing = True
        try:
            async with self.lock:
                if not self.aborted:
                    self._publish(await self._run(self.engine.finish))
                self.ended = True
                self.changed.set()
        finally:
            self.ended = True
            self.changed.set()
            self._cleanup()

    def _cleanup(self):
        if self.cleanup is None:
            self.cleanup = asyncio.create_task(self._release())

    async def _release(self):
        try:
            async with self.lock:
                if self.engine is not None:
                    try:
                        await self._run(self.engine.close)
                    except SpeechError:
                        pass  # Drop all remaining references even if native cleanup reports failure.
        finally:
            self.engine = None
            self.engine_factory = None
            self.executor.shutdown(wait=False)
            await self.release(self)

    async def close(self):
        self.aborted = self.ended = True
        self.queue.clear()
        self.changed.set()
        self._cleanup()
        # An active synchronous call may finish later; its slot remains leased until then.
        if not self.lock.locked():
            await asyncio.shield(self.cleanup)

    async def wait_closed(self):
        if self.cleanup is not None:
            await asyncio.shield(self.cleanup)
