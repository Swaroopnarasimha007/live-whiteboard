# Session, context and audio integration

Agent 6 owns src/session, src/context and src/audio. The default **Mock demo** requires no microphone permission. **Local recording — transcription mocked** captures audio only into a bounded in-memory preview while the same mock transcript drives generation. Neither mode uploads audio or calls a model/STT provider.

```ts
const session = createSessionController({
  store,
  consumer,
  transport: new MockGenerationTransport(),
  getContext: () => currentContextView(store, viewport, editor),
  subscribeInteraction: editor.subscribe,
});
await session.start('mock');
// session.pause(); await session.resume(); session.sendNow();
// session.stop(); session.retry();
// After explicit UI confirmation: session.reset({ confirmed: true });
// session.dispose(); consumer.dispose(); editor.dispose(); store.dispose();
```

The controller owns its injected speech and microphone sources and disposes them. It borrows the store/consumer. Its public methods are getSnapshot, subscribe, ingest, start, pause, resume, stop, sendNow, retry, reset and dispose; microphone exposes the preview source. Snapshots are immutable and expose independent capture and generation axes, interim/final transcript, queue counts/age, model latency, request inspector and recovery status. UI observers cannot interrupt lifecycle cleanup.

## Scheduling and backpressure

SpeechEvent is exactly `{id, text, startMs, endMs, isFinal}`. speechEventSchema validates it. Interim revisions update the display without creating requests. Final IDs are accepted once per session; identical duplicates are acknowledged, conflicting reused IDs are rejected. Corrections must use a new final ID. Finalized ID receipts live until document/session replacement or disposal.

The first idle final starts a 400 ms grouping window; subsequent finals do not restart it. While a request is active, subsequent finals accumulate. After successful completion, queued text sends immediately in a single new request with fresh context. Send now bypasses the grouping delay. Only one consumer request may be active, including the separate developer stream control. The stream's isActive() guard covers the interval between synchronous cancellation and async cleanup.

Queued text is bounded to 10,000 characters, counting separators, or a 30-second timestamp span from earliest start to latest end. Exact limits accept the event and pause intake; an event that would exceed the limit is not accepted. ingest returns false, with a visible message: the source must retain that event and retry after Resume. MockSpeechSource does this without advancing its cursor. Individually oversized segments must be split/corrected by the adapter. No silent truncation, evictions or automatic loss of speech occur. The failed in-flight batch remains separately associated with its partial drawing.

Queue age measures wall time since the oldest current queued event was accepted; model latency starts when a request is dispatched. They are separate snapshot values, refreshed every 250 ms while relevant. The visible transcript keeps 200 recent final entries with a hidden-entry count; queue records and finalized-ID receipts are separate and unaffected by display trimming.

Pause stops intake and pauses local recording, holds queued text, and lets the current generation finish. Resume preserves the source cursor and sends queued text when allowed. Send now can explicitly send held text while capture stays paused/stopped. Stop cancels input/generation, clears preview audio, retains accepted drawing and queued text, and pins an interrupted request for explicit Retry. New queued speech waits while a failed request needs retry; there is no automatic replay.

Retry reuses the original immutable request, base revision, segment IDs, operation order and namespace. It does not refresh context. Accepted operations remain deduplicated and intervening manual changes remain protected. Fresh context is used for the next new batch. Reset requires `{confirmed: true}` and the app asks before invoking it; it clears document/transcript, advances the store epoch and stops all sources. A version guard ignores old async completion callbacks. Successful external document import/reset has the same session cleanup. Generation-only epoch invalidation preserves unsent text for an explicit new send and marks interrupted segments failed without replaying them.

## Full immutable context

buildGenerationRequest(options) returns a schema-validated, deeply frozen GenerationRequest with fresh section bounds/origins, all nodes/edges, current manual positions and dimensions, defaulted values/source/revision, current viewport/visible bounds, active generation section and selected IDs. It excludes editor previews, native scale, callbacks, history and audio. Zod cloning prevents mutable input references from leaking into an in-flight snapshot.

The runtime prefers the camera's live generation section, then the editor's active section, then the newest section; manual browsing does not silently redirect generation from an established live section. Context is built immediately before sending. If interactionInProgress is true, generation remains queued until the editor subscription signals commit/cancel. Resume work runs after synchronous store/editor notifications to avoid reentrant commands.

DEFAULT_CONTEXT_BUDGET is 256 KiB of UTF-8, measured over the entire serialized request, including transcript/metadata. budgetBytes is configurable; it never triggers hidden summaries or truncation. ContextError reports INTERACTION_ACTIVE or CONTEXT_LIMIT. Limit failures leave all queued text intact and generation paused; reduce the board or change the configured budget, then Send now. inspectGenerationRequest returns the exact JSON and byte count used by the developer inspector.

## Mock speech

MockSpeechSource emits deterministic timed fixtures: interim text, finalized Browser/Server/edge segments, an API-server correction, a database explanation, an explicit topic transition and Unicode/out-of-order operations. Default fixture IDs use `demo-…__run` suffixes so repeated runs have unique finalized IDs; buildDemoOperations recognizes only the explicit known fixture prefix before `__`. Renderer text/timers never infer topics. A completed default source can start a fresh run; Stop retains its remaining cursor, while reset restarts the fixture sequence. Paused time does not consume fixtures.

Custom SpeechFixture arrays supply atMs and a validated SpeechEvent. SpeechSource's start callback returns boolean acceptance; false pauses without consuming the current fixture. A future STT source must honor the same backpressure contract.

## Local microphone lifecycle

MicrophonePreviewSource requests getUserMedia only after an explicit Start action. It checks secure context and MediaRecorder support, reports denied permissions/no device/busy device/recorder failures, and observes track ended events for device removal. Controls show requesting, recording, paused, idle or error with recovery guidance. A pending permission prompt may remain unresolved; Stop invalidates its token and stops every track if access is granted later. This follows the browser's asynchronous permission model. [MDN getUserMedia documentation](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) describes these errors and the HTTPS/localhost requirement.

Recording uses separate approximately 10-second MediaRecorder sessions. Each session collects all its timeslices and exposes a Blob URL only after recorder stop completes. Pause finalizes the current short recording and disables tracks; Resume starts another. Rotation can introduce small gaps and is intended for preview, not continuous archival capture. The recording specification guarantees playability for all blobs from a completed recording, not each individual timeslice. [W3C MediaStream Recording](https://www.w3.org/TR/mediastream-recording/) provides that container requirement.

The preview retains at most 60 seconds of complete clips plus the current segment, and defaults to an 8 MiB encoded-byte cap. Old complete clips are evicted atomically, URLs revoked, and discarded duration shown. A single oversize/overlong active segment fails visibly and is discarded. Limits are checked on timers/data events; background browser scheduling can delay those events, and native browser encoder buffers are outside application control. Shorter segment/duration/byte limits and an injected MediaEnvironment are available for tests.

Stop, Reset and disposal stop every track, cancel timers, clear chunks and revoke every retained URL. Stop deliberately discards previews; Pause allows playback of completed clips. Audio is not persisted, uploaded or included in request JSON. MediaEnvironment and MicrophoneSnapshot/PreviewClip types expose the capture boundary without coupling it to React.

## Future transcription boundary

CapturedAudio describes a Blob, MIME type and timestamps; TranscriptionAdapter.transcribe(audio, signal) produces AsyncIterable<SpeechEvent>. A future integration explicitly sends capture to an authenticated backend transcription endpoint, validates unique final segments, honors queue backpressure and submits only those segments to the session controller. Raw audio stays outside the drawing protocol. Provider API keys belong on the server, never in the browser bundle. HTTPS or localhost is required for browser microphone access. No backend, provider adapter, keys or network audio upload is implemented here.

Run npm run test:session-browser for real Chromium generation/context and recording journeys. The recording tests use a browser fake media device and automatic test permission, exercise native MediaRecorder and verify playable previews/ended tracks/revoked URLs. Real physical-device removal, OS permission UI, Safari/Firefox and long background recording require later QA.
