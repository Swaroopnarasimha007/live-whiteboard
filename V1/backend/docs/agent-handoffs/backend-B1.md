# B1 handoff — 2026-11-03

B1's local speech components are implemented. Stopped before B2. Production session creation, audio route mounting, live-mode/profile-picker UI composition and the diagram pipeline remain assigned to B2/B3/B0 integration; they have not been substituted with an unauthenticated audio shortcut.

## Delivered and checklist

- [x] Official model setup script for both US and Indian English profiles; bounded HTTPS downloads, archive validation, staged extraction, overwrite refusal, provenance and optional trusted-checksum verification.
- [x] Preserve every upstream file. These two official archives supplied READMEs but no separate LICENSE file; the observed catalog declaration `Apache-2.0` and source link are recorded in `MODEL_SOURCE.json`. No invented upstream license file or trusted checksum was added.
- [x] Explicit speech registry with allowlisted profiles/default policy, pinned settings, availability checks and actionable safe errors.
- [x] Lazy bounded model cache, deduplicated concurrent loads, leased-model protection, recognizer limits and shutdown cleanup.
- [x] Separate recognition engine per stream, ordered native calls on a dedicated worker, model loads off the event loop, no shared recognizer state.
- [x] Vosk adapter plus deterministic request-flow/silence/continuous/error mock fixtures, through the same frozen `Transcriber`/`SpeechStream` boundary.
- [x] Stable interim/final IDs, sample-based times, partial throttling, exact segment-size splitting, bounded forced finalization, finish/abort/cleanup semantics.
- [x] Session-bound WebSocket service with handshake/format validation, immutable capture profile, bounded PCM/event queues, overload errors and cancellation cleanup.
- [x] Browser AudioWorklet PCM capture, downmixing, stateful windowed-sinc low-pass resampling, little-endian encoding, normal 100 ms frames and short final frames.
- [x] Browser ready-before-capture/send, fresh stream IDs, bounded worklet/main/WebSocket buffering, transcript adaptation/backpressure and sample-based pause/resume offsets.
- [x] Tracks/contexts/worklets/sockets cleaned up on stop/dispose; stale events ignored; denied permission/no device/unsupported capture/disconnect/malformed protocol paths tested.
- [x] Real Vosk load/silence smoke for both installed profiles and the same synthetic speech WAV transcribed through both adapters.
- [ ] Full microphone → authorized production session → generation → canvas integration, profile picker, reset ownership and public route mounting: requires B3/B2 and final B0 composition.
- [ ] Representative real recordings, forced-boundary accuracy, word-error-rate, recognition real-time factor/CPU/memory benchmarks and platform matrix: B4. Synthetic smoke is not a quality benchmark.

## Public exports and integration seam

`app.speech.SpeechRegistry(settings)` implements `open_stream(SpeechStreamConfig) -> WorkerSpeechStream`. It also exposes `select_profile(requested=None)`, `availability(profile) -> (bool, reason|None)` and `aclose()`. Its deep-copied settings pin effective configuration. The explicit provider registry supports `mock` and `vosk`; no config/client input names arbitrary modules. `SpeechError` carries `code` and a safe `message`.

The app lifespan creates `app.state.speech_registry` and registers shutdown cleanup on the B0 exit stack before later composition hooks. Capability stage is now `B1`. Only approved profiles appear publicly. Mock is available without optional dependencies; Vosk requires model-layout prerequisites and the optional package, and actual native load/recognizer construction is validated lazily. Missing/corrupt optional models do not break startup or standalone board use. `services.speech` is true; `services.audio`, `sessions`, `generation`, `replay` are still false. Health readiness still means initialized components, not an end-to-end live application.

`WorkerSpeechStream` honors the frozen methods: `push_audio(bytes)`, one async `events()` iterator, graceful `finish()`, idempotent aborting `close()`. `wait_closed()` is an additional cleanup/testing seam. Finish stops new input, drains frames already accepted by ordered callers, flushes a nonempty final segment and ends the iterator. Consume final events before calling aborting `close()`. Close clears queued events and prevents late worker results from being published. When a native call cannot be interrupted, its recognizer/model lease remains held until ordered cleanup can run; do not assume immediate CPU release. Registry shutdown waits for native calls to return.

Segment IDs are `{streamId}_{ordinal}`; stream IDs are restricted to 48 characters so the final ID fits the shared 64-character limit for practical session lengths. Sample time starts at zero per connection. Interim revisions reuse an ID, final revisions are immutable, and partial emissions are throttled against accepted samples (default 150 ms). Every frame is split at a forced segment boundary if necessary (default 4 seconds). Vosk uses real `Result`/`FinalResult`, and recreates its recognizer after forced finalization. Forced boundaries may split words; no confidence/accuracy is fabricated.

`app.speech.socket.AudioSocketService(registry).handle(websocket, binding)` owns B1's protocol/queues. **B3 must resolve and authorize the route's session before invoking it.** The `AudioSession` protocol requires:

```python
session_id: str
session_epoch: int
profile: str
async def claim_audio(stream_id: str) -> None: ...
async def release_audio(stream_id: str) -> None: ...
def audio_is_current(stream_id: str) -> bool: ...
```

Claim must atomically reject an existing capture or reused stream ID and bind the capture to its epoch. Release must be idempotent and release only the matching stream. `audio_is_current` must compare the claimed epoch/stream against current session state. B3 must cancel the handler on reset/delete/expiry so idle sockets are cleaned up too. The service checks current ownership on every received audio/control message and before transcript sends; it does not own a second session registry or board. Tests use a private in-process binding harness, not a public session bypass.

The production `WS /api/v1/sessions/{id}/audio` remains the B0 1013 stub until B3 mounts the service. Existing HTTP session/generation/replay stubs remain unchanged. The CLI now bounds WebSocket transport frames to 64 KiB, queue depth 4 and disables per-message compression; the service separately enforces PCM frames ≤32,000 bytes, even-sized/nonempty, 16 kHz mono, control text ≤4096 bytes and the configured queued-audio budget. Origin is checked both at the app boundary and in the service. Handshake timeout is 10 seconds, socket sends are bounded at 5 seconds. Application code has no unbounded audio queue.

The socket start/ready/transcript/error/closed schemas remain protocol version 1. For example:

```json
{"type":"start","audioProtocolVersion":1,"streamId":"a1","sessionEpoch":1,"profile":"mock","format":{"encoding":"pcm_s16le","sampleRateHz":16000,"channels":1}}
```

Then wait for ready before PCM. `finish` flushes and delivers final transcript events before `closed: finished`; `abort` discards unfinished recognition and emits `closed: aborted`. Bad protocol/format, stale ownership, missing model and overload produce safe error/closed messages once stream metadata is known. Invalid pre-handshake messages close with 1008. Disconnects do not replay audio. Worker/send/receiver tasks are cancelled on exit; session lease cleanup is shielded from ASGI disconnect cancellation. A noninterruptible native call may finish after the socket is gone, but cannot publish late transcripts.

## Frontend boundary

`src/audio/backend` exports `BackendSpeechSource`, options, audio schemas/types, environment interfaces and pure PCM helpers. `src/audio/index.ts` also re-exports `BackendSpeechSource` for composition. It implements the existing `SpeechSource` interface. B3 supplies an already-authorized session via `session(): {url,sessionEpoch,profile}` and plugs the source into the existing session scheduler:

```ts
const speech = new BackendSpeechSource({
  session: () => ({
    url: /* authorized session's audio WebSocket URL */,
    sessionEpoch: /* reconciled backend epoch */,
    profile: /* selected allowlisted backend profile */,
  }),
  onError: ({ code, message }) => { /* show actionable capture state */ },
});
```

The session/config snapshot is pinned when each capture begins. Changing profiles requires stopping capture and obtaining the appropriate B3 session/profile binding; no recognition switch occurs mid-utterance. Start obtains backend ready before opening the microphone. Pause flushes and closes its stream; resume waits for closure and opens a fresh stream ID. Stop aborts; reset also resets the sample timeline and pending transcript. Interim events remain interim at the existing scheduler boundary. No generation trigger or second scheduler was added.

`onEvent` false retains transcript and pauses input. The adapter drains retained text before restarting capture. Pending transcript is bounded to the existing 10,000 characters/30 seconds plus 256 records; overflow is surfaced explicitly and capture stops. Session-relative timestamps sum sent PCM durations, excluding wall-clock pauses. A lost connection reports an interruption; no claim is made that unacknowledged frames were transcribed. Late stream/epoch messages cannot update a replacement capture.

The worklet gets native-rate samples, downmixes, filters with a persistent 64-tap windowed-sinc kernel and retains fractional phase/history across render quanta. It produces mono 16 kHz signed-16 little-endian PCM and normally frames 1600 samples/3200 bytes. A credit budget bounds outstanding worklet messages even when the main thread stalls. Main-thread and socket buffering share the configured byte limit. Exhaustion stops processing and reports a gap/error, then the main thread releases capture resources. `MediaRecorder` preview remains separate and compressed blobs are never sent as PCM.

## Files changed

- New `backend/app/speech/{__init__,errors,models,engine,mock,vosk,stream,registry,socket}.py`.
- New component tests `backend/app/speech/{test_speech,test_socket,test_models}.py`.
- New `backend/scripts/models/{__init__,install,smoke}.py`.
- Composition/configuration changes in `backend/app/{main,__main__}.py`, `backend/app/config/capabilities.py`, `backend/config/settings.example.yaml` and updated foundation stage/capability assertions in `backend/tests/test_foundation.py`.
- `backend/pyproject.toml`, `backend/uv.lock`: exact `vosk==0.3.45` optional speech extra, `websockets==16.1.1` and explicit `anyio==4.16.0` runtime dependencies. Mock imports no optional native package. Optional speech CI job runs no downloads and reports model-test skips.
- New frontend `src/audio/backend/{index,protocol,resampler,capture.worklet,browser,source}.ts`, component unit tests, worklet browser test/config and independent production build config. `src/audio/index.ts` re-exports the source.
- `src/audio/audio.test.ts`: repaired the pre-existing test mismatch against the default finalized `tour-*` fixture. The demo behavior in `src/audio/mock.ts` was not changed.
- Root README, CI workflow and this handoff. Shared wire schemas/fixtures were unchanged and drift checks still pass.

## Actual verification

Local Windows, Python 3.10.11, uv 0.13.7. All added dependencies were resolved from the registry during implementation and locked. Both official models were downloaded with the new installer into ignored `backend/models/` and loaded through the same adapter. Original READMEs were preserved.

- `uv sync --project backend --locked --extra speech`: passed.
- `uv run --project backend --extra speech pytest -q`: **54 passed**, including both real Vosk load/silence smoke tests. Coverage includes worker isolation/order, forced boundaries, idempotent finish/close, queued audio before finish, active-call/initialization cancellation, lazy-load deduplication/cache leases, missing optional models, client-selection policy, bounded queues, protocol/epoch/origin errors, abort/disconnect and archive path defenses.
- A separate base-only `uv sync --project backend --locked` and `pytest -q -rs`: **52 passed, 2 explicitly skipped** real-model tests because Vosk was intentionally uninstalled. The speech extra was restored afterward.
- `ruff check backend`, `ruff format --check backend`: passed.
- Shared schema/fixture drift checks with `--check --frontend-root ../rendering`: passed (nine schemas).
- Frontend `npm test -- --reporter=dot`: **248 passed**. The existing audio fixture failure from B0 is resolved.
- Frontend typecheck, lint and standard production build: passed; standard build retains its existing bundle-size advisory.
- Independent `npx vite build --config src/audio/backend/vite.capture.config.ts`: passed, emitting a JavaScript AudioWorklet asset and adapter bundle to ignored cache output. This verifies bundling while application live mode awaits B3.
- `npx playwright test --config src/audio/backend/playwright.config.ts`: **1 Chromium test passed**, using actual AudioWorklet code with synthetic input and explicit 44.1/48 kHz contexts, aligned PCM frames and stopped tracks. The test waits for sample progress rather than assuming browser audio processing follows wall-clock deadlines.
- Existing `npm run test:stream-browser`: **3 Chromium tests passed**, preserving incremental standalone generation/canvas behavior.

Real same-input speech check used a local Windows System.Speech synthesized WAV at 16 kHz mono signed-16 PCM, saying: “The browser sends a request to the server. The server queries the database.” `backend/scripts/models/smoke.py` produced the following **for both profiles**:

```text
the browser censor request to the server the server queries the database
```

This is a smoke test with a visible recognition error, not evidence of representative accuracy or superiority of either profile. The WAV is ignored local test data; no microphone recording was made. No word-error-rate, latency, memory or real-time-factor benchmark is claimed. Real microphone permission paths are simulated in unit tests; browser capture uses a synthetic oscillator stream.

Observed download hashes are recorded below for reproducibility, **not independently trusted verification**:

- US archive: `30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498`.
- India archive: `20663dcac4d5cb783a579c54d98339344a688e4ec6e1b4a4b059fd1235454cc7`.

No full microphone-to-canvas backend e2e, deployment/proxy test, public route ownership implementation or non-Windows native test has been claimed. Those are future integration/B4 gates. Starlette's existing `httpx` test-client deprecation notice remains informational; the frozen tests pass.

## Demonstration and remaining work

Success without optional dependencies: run the backend normally and inspect capabilities. Mock speech is available while the production audio endpoint honestly remains unmounted. Run `uv run --project backend pytest backend/app/speech/test_socket.py -q` to exercise the bound-session mock audio socket through its component harness.

Real success: install the speech extra/models using README commands, then run `uv run --project backend --extra speech pytest backend/app/speech/test_speech.py -q -rs`. To inspect actual text for a consented WAV, use `uv run --project backend --extra speech python backend/scripts/models/smoke.py path/to/sample.wav`.

Failure: selecting an unavailable model returns a safe `model_not_installed`/`provider_not_installed` error; a different profile when client selection is disabled returns `profile_selection_disabled`. Odd/oversized PCM, stale epochs, a second start on an active socket and buffer overflow are rejected explicitly. Structural extraction verification and actual model-load smoke are separate checks. Existing model directories are never overwritten by setup.

B3 should mount the service using its real session registry and integrate `BackendSpeechSource` with capability discovery and the existing UI. B2 should implement diagram generation independently while audio continues. B4 should measure representative speech, segmentation tradeoffs, actual throughput/memory and browser end-to-end behavior before live-quality or latency claims. B0 should then wire the profile picker and review integrated handoffs. Stop here until the next stage is requested.
