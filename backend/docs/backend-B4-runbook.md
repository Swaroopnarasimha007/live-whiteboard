Current speech UI and installation: [Whisper hold-to-talk handoff](hold-to-talk-whisper.md). Older benchmark numbers below predate the migration.

# B4 integration and operations runbook

The application uses one loopback backend process. Browser scene persistence is independent of backend session/replay state. Restarting the backend loses session IDs and retained events; Start reconnects with a new identity and full current scene. Replay only repeats retained events and cannot repair a failed request. Continue with fresh context creates a new request. Stop closes capture and cancels generation; Reset also clears the scene and advances the epoch.

## Reproduce the mock gate

From `C:\Work\backed` in PowerShell (use `uv` on PATH, or `.\.venv\Scripts\uv.exe`):

```powershell
uv sync --project backend --locked
uv run --project backend pytest -q -rs
uv run --project backend ruff check backend benchmarks/backend deployment
uv run --project backend ruff format --check backend benchmarks/backend deployment
uv run --project backend python backend/scripts/export_protocol.py --check --frontend-root ../rendering
```

Ordinary tests download no models and contact no paid provider. The five credentialed tests and two real-WAV tests skip explicitly without their opt-ins. Test listeners use ephemeral loopback ports, shut down their threads, and release sockets. Browser acceptance owns ports 8024 and 4194; stop any process already using these ports before running it.

From the sibling `C:\Work\rendering`:

```powershell
npm ci
npx playwright install chromium
npm run test:backend-contracts
npm run test:backend-e2e
npm run check
```

The backend browser config starts `tests.integration.fixture_server`, never a live provider. Its pause, stale-update and malformed-EOF controls exist only in test composition. No second production application, scheduler, or scene store was introduced. The actual restart test creates and terminates a separate backend subprocess on an ephemeral port; it preserves the running browser page.

The explicit contract runner requires the canonical backend corpus. Set `WHITEBOARD_PROTOCOL_DIR` to a directory containing `fixtures.json` for a nonstandard checkout arrangement. A missing corpus fails that command clearly. The B4 Vitest file skips when independently discovered without a backend, while existing frontend-local fixture tests remain active. Default frontend Vitest currently includes only `src/**/*.test.*`, so the explicit B4 command is necessary.

## Both real speech profiles, without paid services

Install the existing `speech` extra and both approved models. Preserve upstream license/source files; WAV fixtures and downloaded weights are ignored artifacts.

```powershell
uv sync --project backend --locked --extra speech
Push-Location backend
uv run --extra speech python -m scripts.models.install whisper-small
uv run --extra speech python -m scripts.models.install whisper-medium
Pop-Location
```

Whisper installation pins an upstream snapshot revision and supports resuming downloads. Use `--verify` to check loadability of an existing model.

Keep the speech extra installed throughout this gate. An ordinary `uv sync` or `uv run` without `--extra speech` can resynchronize this environment and remove Whisper even after a successful model test. Run ordinary mock/lint gates first, or include `--extra speech` in every subsequent uv command that shares the environment. Before browser speech acceptance, restore it with `uv sync --project backend --locked --extra speech`. The browser test requires the chosen option to be enabled and the bridge to commit that profile before Start, then separately verifies the actual server-issued identity profile; unavailable speech prerequisites must never pass as mock speech.

Generate a local synthetic utterance and record its voice, source text, checksum, and limitations:

```powershell
./benchmarks/backend/generate-speech.ps1
Push-Location ../rendering
node --experimental-strip-types tests/backend-e2e/resample.ts ../backed/benchmarks/backend/fixtures/technical.wav ../backed/benchmarks/backend/fixtures/technical-16k.wav
Pop-Location
$env:WHITEBOARD_MODEL_TESTS='1'
uv run --project backend --extra speech pytest backend/tests/integration -q -rs --junitxml=benchmarks/backend/speech-junit.xml
Push-Location ../rendering
npm run test:backend-e2e
Pop-Location
Remove-Item Env:WHITEBOARD_MODEL_TESTS
```

Windows synthesis uses offline `System.Speech` with original task-specific text; no microphone or human recording is used. The Linux generator uses explicitly installed `espeak-ng` (`python benchmarks/backend/generate-speech-linux.py`). Run the same TypeScript conversion afterward. Conversion parses PCM WAV and invokes the exact production `PcmResampler` with 128-sample chunks, downmixing and PCM16 encoding. It is not an ffmpeg substitution for production DSP. Both profiles receive the identical converted bytes. The fixture is 11.3928125 seconds in the recorded Windows run; Linux voice duration and accuracy will differ.

`WHITEBOARD_MODEL_TESTS=1` makes missing WAV/model prerequisites fail rather than quietly calling a fake recognizer. Browser tests select each approved UI profile, send paced synthetic PCM over the real authorized WebSocket, observe finalized transcripts, schedule HTTP mock generation, and verify canvas output and capture cleanup. They do not test microphone permission or physical microphone quality; existing audio capture browser tests cover the AudioWorklet lifecycle separately.

The optional GitHub job runs only on manual dispatch with `speech=true`. Supply `rendering_repository` and `rendering_ref`; it explicitly checks out sibling `backed` and `rendering` directories, installs Linux TTS and both models, production-resamples the WAV, and runs model/browser acceptance and reports. A private paired repository requires the workflow checkout token to have read access. This workflow definition was inspected locally; no hosted CI run is claimed.

## Measurements and provider reporting

```powershell
./backend/.venv/Scripts/python.exe benchmarks/backend/run.py --speech --output benchmarks/backend/latest.json
./backend/.venv/Scripts/python.exe benchmarks/backend/provider-smoke.py
```

The first command measures a modest sequential mock workload, same-process TCP/ASGI spans, an active cancelled paused-provider cleanup, and optional offline speech. It saves hardware/configuration, raw transcript, WER, term matches, frame submission-to-worker delay, engine work, finish flush, RTF, and process RSS snapshots. `tracemalloc` excludes native memory; RSS includes the process and allocator/cache retention. Neither is a claim of isolated per-model allocation or a long-running memory plateau.

Browser acceptance writes JSON reports below `rendering/test-results/` and attaches them to Playwright. The draw test measures complete HTTP-operation receipt to actual Konva `onDraw` using browser `performance.now`. Speech tests record capture start to first-node Konva draw, received finalized transcripts, represented-frame-send to final receipt, transcript receipt to generation submission, and observed scheduler queue age. The speech run contains one synthetic trial per profile and may overlap other regression work; it is diagnostic, not a representative latency distribution. Konva draw is not physical-screen presentation. Python and browser clocks are never subtracted or added.

`provider-smoke.py` writes one explicit skipped row per provider by default, even when keys exist. Live calls require explicit authorization followed by `--allow-paid`, enabled valid profiles, exact model IDs, and referenced credential environment variables. The runner emits exact configured provider/model IDs, elapsed durations and JUnit paths; skipped preflight remains skipped rather than labelled verified. Never paste keys into config or command arguments. No live calls were made for B4. The five-provider synthetic matrix is the offline conformance gate, including text/usage/single-terminal, length/refusal/EOF/error/cancel behavior; B2 component tests additionally cover tools/thought blocks, all normalized HTTP errors and trailing metadata.

## Proxy/deployment streaming

`backend/tests/integration/test_proxy.py` uses an actual local reverse proxy and a gated producer: it must receive the first operation before the test releases completion. It requests gzip and verifies uncompressed streaming headers. This verifies the local proxy fixture only. nginx, Docker, public HTTPS, remote network conditions, and production CDN behavior were unavailable and are not certified.

`deployment/nginx.streaming.conf` is a loopback-only nginx `http {}` include listening on `127.0.0.1:8080`, with request/response buffering, cache and gzip disabled and WebSocket upgrade forwarding. Keep backend workers at one. Serve the browser separately; configure its actual origin in backend settings. The sample does not implement authentication, TLS termination, or durable session storage.

To check an installed proxy, run the B4 fixture server on 8024 and proxy `/api/v1/` to it. Then:

```powershell
uv run --project backend python deployment/probe_streaming.py --base-url http://127.0.0.1:8080
```

The probe requires the paused B4 fixture, checks no content encoding plus `X-Accel-Buffering: no`, and verifies a measurable gap between first operation and terminal receipt. Running it against an unpaused or live provider is unsupported. Inspect the first and terminal records in browser network timing as a deployment-specific follow-up. A proxy or hosting layer that buffers must be corrected before interpreting streaming latency.

## Recovery and limits

For `overloaded`, stop another capture or reduce intake and resume explicitly; queued audio is bounded, and oversized input produces an explicit interruption. For unavailable profiles, verify enabled IDs, model files, speech extra, and configuration. Stop capture before switching profiles. Disabled client selection enforces the backend default.

For `session_expired` after restart, keep the drawing and Start again. For replay 410, use a fresh request with current context; do not regenerate under the old request identity. For failed or truncated output, retain completed drawing objects and inspect diagnostics. Manual objects/locks and edits newer than a request stay protected.

Default session/replay/model/recognizer limits remain configurable. B4 verifies finite repeated-session capacity and bounded retention tests; it does not add multi-worker persistence, hours-long soak proof, real lecture/accent benchmarking, a natural speech-endpoint metric, or verified live-provider billing cancellation. Browser Stop initially exposed a terminal-send disconnect race; the companion review fix makes that acknowledgement best effort while always releasing capture ownership.
