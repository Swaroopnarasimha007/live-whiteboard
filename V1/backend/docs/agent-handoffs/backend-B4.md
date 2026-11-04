# B4 handoff — 2026-11-03

B4 implements the integration acceptance, benchmark/reporting, deployment-test assets, and runbooks in sections 13–14. Runtime fixes remain owned by the companion review chat; see `backend-review-fixes.md`. Both checkouts were reused. No worktree, paid API call, production multi-worker persistence, or external communication was introduced.

## Delivered components and contracts

- `backend/tests/integration/` adds actual TCP/WebSocket acceptance for fragmented/corrupt/interrupted generation, prefix preservation, replay, sequence identity, bounded repeated-session capacity, audio overload, old-epoch rejection, disabled profile selection, and a gated streaming reverse proxy. The common listener binds ephemeral loopback ports, joins its worker, and closes its socket.
- The five-provider synthetic matrix reuses B2 provider-shaped SSE fixtures and native adapters. Thirty shared scenarios cover stop/usage/text, length, refusal, EOF, HTTP error, and cancellation for Groq, OpenRouter, OpenAI Responses, Gemini, and Anthropic. B2 tests retain the finer tool/thought/error/duplicate-finish/completed-snapshot checks. Synthetic model ID is `test-model`; no model endpoint is contacted. Unknown usage stays null, and cumulative snapshots merge without summing.
- Browser acceptance uses the existing runtime, context builder, typed transport, scheduler, scene protection, and production Konva Whiteboard. The dedicated fixture composition starts on backend 8024 and frontend 4194; no fixture route is mounted by `app.main`. A separate test actually terminates/restarts a backend subprocess on an ephemeral port while retaining the same browser page.
- Cross-language tests read the canonical Python fixture file directly for operation, generation request/event, and audio server events. The explicit frontend command fails clearly when that corpus is absent; `WHITEBOARD_PROTOCOL_DIR` overrides its location. Existing frontend-local fixture tests remain unchanged and ordinary standalone frontend tests do not require the sibling checkout.
- Both model tests use the same generated WAV, production-resampled via `PcmResampler`, with forced segmentation through `SpeechRegistry`/ordered workers. Opt-in browser tests select both profiles through the approved picker, send paced PCM through the real mounted WebSocket, feed final transcripts to the real scheduler/HTTP mock generation, and observe actual canvas draws and capture cleanup.
- Reports separate Python monotonic spans from browser monotonic spans. Active cancellation is timed through the paused local provider iterator's observed `finally`, rather than inferred from a correctness wait. Provider smoke defaults to five explicit skips even if credentials happen to exist; explicit `--allow-paid` plus configured credentials/models is required to make live calls.
- The optional Linux CI job explicitly installs `espeak-ng`, creates provenance metadata, checks out the separate paired frontend repository supplied by workflow input, production-resamples audio, installs both model profiles, and runs model/browser reports. Normal CI uses no model downloads or paid providers. The CI workflow was not executed on a hosted runner during B4.

Production wire contracts and public endpoints are unchanged. `tests.integration.fixture_server` additionally exposes test-only `POST /_b4/api/v1/generations`, which deliberately emits two complete operations followed by truncated JSON. Its ordinary generation wrapper pauses 300 ms after each operation and recognizes one explicit stale-update fixture transcript. These are isolated test seams, not product controls.

## Section 14 scenario map

| Required scenario | Executable evidence | Limits |
| --- | --- | --- |
| 1. Mock transcript → fresh context → HTTP stream → visible before terminal | `acceptance.browser.spec.ts`; `draw.browser.spec.ts`; actual Konva `onDraw` before completion | Synthetic PCM and mock diagram; separate draw benchmark records actual callback, not physical screen |
| 2. US speech then Indian speech → mock diagram | `speech.browser.spec.ts` per profile over mounted WS → scheduler → HTTP → canvas; `test_speech_profiles.py` full identical WAV | Opt-in models/fixture; one synthetic voice, no microphone/lecture evaluation |
| 3. Manually add/move Database; next context has exact ID/bounds and edge reuse | `scene.browser.spec.ts` manual Database case checks sent network body, committed geometry, manual source, reused generated edge, and edge lock/source/revision | Uses real command store API in browser rather than pointer dragging |
| 4. Manual label edit during generation rejects stale update | `scene.browser.spec.ts` stale-update fixture; verifies rejected operation and next committed context | Deterministic test-composition stale update |
| 5. New topic creates section and respects suspended follow | `scene.browser.spec.ts` expired-identity/topic-change case checks Next topic and unchanged manually panned camera | Existing board/camera regressions provide broader camera cases |
| 6. Mid-JSON disconnect preserves completed objects | `scene.browser.spec.ts` truncated real HTTP fixture checks two applied operations, Retained Browser and TRANSPORT diagnostic | Actual consumer contract uses terminal phase `error` for malformed EOF; it does not falsely report completion |
| 7. Replay preserves sequence, no duplicate operation | `scene.browser.spec.ts` replay; `test_acceptance.py`; existing B3 real TCP cancellation/replay test | Retained in-memory replay only |
| 8. Continuous speech segmentation, bounded queue/explicit overload | Both real-WAV profile tests assert multiple finals ≤4 s; `test_audio_network.py` sends valid 1 s PCM into configured 200 ms bound and receives explicit overloaded/closed | Finite fixtures; scheduler queue limits/age behavior also covered by existing session component tests; not an hours-long lecture soak |
| 9. Stop/reset cleans audio and rejects late messages | `acceptance.browser.spec.ts`, `speech.browser.spec.ts`, replay/reset scene case; real WS stale-epoch case | Harness counts capture resources; existing capture browser suite covers real AudioWorklet/media lifecycle |
| 10. Backend restart; browser drawing survives, reconnect sends full context | `restart.browser.spec.ts` kills/restarts an actual Python backend subprocess, preserves same page and drawing, asserts new session and full node context | Separate scene case deletes session to exercise 410; that case is explicitly not labelled a process restart |

The long-session gate verifies 25 cycles × two sessions with explicit capacity rejection and release plus existing bounded replay/recognizer tests. It is not a measured hours-long memory plateau.

## Actual measurements

Authoritative saved reports: `benchmarks/backend/measured-windows.json`, `measured-browser.json`, and `provider-smoke.json`. Hardware: Intel Core i5-13500H, 16 logical CPUs, approximately 15.63 GiB RAM, Windows build 26200, Python 3.10.11; browser report records headless Chromium 156.0.8078.4. Configuration fingerprint is embedded. Measurements occurred with concurrent implementation chats; final correctness reruns may also overlap regression load.

| Span/workload | Recorded result |
| --- | --- |
| 40 sequential loopback mock requests, 120 validated operations; record complete → ASGI send | p95 **0.297 ms** |
| Same operations, record complete → client loopback receipt/decoding | p95 **1.263 ms** |
| Client request → first valid mock operation | p95 **9.679 ms**, 40 samples |
| Active cancel call → observed paused-provider iterator `finally` | **2.525 ms**, one local mock sample; cancellation HTTP roundtrip 2.523 ms |
| Complete HTTP-operation receipt → actual Konva `onDraw` | p95 **20.2 ms**, 30 operations across five requests with 300 ms fixture pauses; first draw before terminal, no pending draws |
| US profile, 11.3928125 s identical synthetic audio | RTF **0.1375**, WER **0.16** (4 edits / 25 words), worker queue p95 **0.211 ms**, finish flush **36.06 ms** |
| Indian profile, same audio | RTF **0.2496**, WER **0.12** (3 edits / 25 words), worker queue p95 **0.260 ms**, finish flush **36.58 ms** |

Both profiles recognized browser/server/database/queue/worker but rendered cache as “cash” in the saved transcript. This tiny synthetic US voice corpus cannot establish which profile performs better on Indian speakers or lectures. The WAV is task-authored offline Windows TTS (`Microsoft David Desktop`), not a human recording; source text, voice and SHA-256 are in `fixtures/technical.json`. Model versions are the directory names `vosk-model-small-en-us-0.15` and `vosk-model-small-en-in-0.4`. Licensed model files/source metadata were preserved.

Python queue timing instruments submission → worker engine start directly; engine work and whole push roundtrip are separate. Flush after final input is a measured finish operation, not natural spoken endpoint latency. Model load and process RSS snapshots are saved; RSS includes allocator/cache retention and is not isolated per-model memory. The mock session report records Python allocation deltas before/after deletion, not a memory leak/plateau conclusion.

The opt-in browser speech tests now attach raw same-browser-clock capture-start → first-node Konva draw, represented-frame-send → final receipt, transcript-receipt → generation-send, and observed queue-age samples. Their final saved artifacts should be copied from Playwright output before another suite clears it. One utterance per profile is a diagnostic sample, not a representative end-to-end distribution. Natural spoken-endpoint latency on annotated consented recordings, physical screen presentation, remote network transit isolation, and live LLM speech-to-first-object distributions remain unmeasured. No timestamps from different clocks were combined.

## Validation performed

From `C:\Work\backed`:

```powershell
.\.venv\Scripts\uv.exe run --project backend pytest backend/tests/integration -q
# 37 passed, 2 explicit model-fixture skips (after proxy + real-WS additions)
$env:WHITEBOARD_MODEL_TESTS='1'
.\.venv\Scripts\uv.exe run --project backend --extra speech pytest backend/tests/integration/test_speech_profiles.py -q
# 2 passed; orchestrator also repeated these successfully
.\.venv\Scripts\uv.exe run --project backend ruff check backend/tests/integration benchmarks/backend deployment
.\.venv\Scripts\uv.exe run --project backend ruff format --check backend/tests/integration benchmarks/backend deployment
.\backend\.venv\Scripts\python.exe benchmarks/backend/run.py --speech --output benchmarks/backend/measured-windows.json
.\backend\.venv\Scripts\python.exe benchmarks/backend/provider-smoke.py
# Five explicit skipped live providers; no paid calls
```

From `C:\Work\rendering`:

```powershell
node --experimental-strip-types tests/backend-e2e/resample.ts ../backed/benchmarks/backend/fixtures/technical.wav ../backed/benchmarks/backend/fixtures/technical-16k.wav
# 22050 Hz mono input → 16000 Hz mono, 182285 samples
npm run test:backend-contracts
# 4 passed against canonical corpus
npm run typecheck
npx eslint tests/backend-e2e --max-warnings 0
npx prettier --check package.json tests/backend-e2e
$env:WHITEBOARD_MODEL_TESTS='1'
npx playwright test --config tests/backend-e2e/playwright.config.ts scene.browser.spec.ts speech.browser.spec.ts
# Final focused run: 7 passed, including all five scene faults/manual/replay cases and both real profiles
```

The remaining mock speech acceptance, actual restart, and actual-draw tests passed in the preceding complete browser run. The last complete 10-case run preceded two harness assertion/layout corrections; the final focused seven cases passed after those corrections. The orchestrator is running the final complete browser gate with isolated output and owns its aggregate result. Its combined backend gate reported **261 passed, seven explicit skips**, Ruff and nine-schema/sibling fixture drift checks passed. It also reported the full frontend check passed (**274 unit tests**), explicit B4 contracts **4 passed**, optional real-profile Python fixtures **2 passed**, and all **64 existing browser tests passed** (default 18, scene 1, layout 1, board 11, editor 12, stream 3, session 7, UI 9, Firefox/WebKit 2). These combined totals were run by the orchestrator, not inferred by B4. B4's final focused lint/format and lock consistency checks also passed.

Warnings observed: existing Starlette/httpx TestClient deprecation, Node type-stripping experimental warning, and Playwright color-environment warning. No live-provider/model-catalog claims were made from skipped tests. Linux optional workflow and nginx sample were not executed here.

A subsequent complete B4 run exposed an environment prerequisite issue: ordinary uv commands had removed the optional Vosk package, capabilities explicitly reported both profiles unavailable (`provider_not_installed`), and selection correctly retained mock. The strict returned-profile assertions caught this; those runs were not counted as real speech. After the orchestrator restored `--extra speech`, B4's isolated full reproduction passed **10/10** (`--output .cache/b4-profile-investigation`, 53.9 seconds). The speech test now also fails early when the selected option is disabled and verifies both DOM value and committed bridge profile before Start. The actual server identity assertion remains strict. The orchestrator owns the final rerun of this additional prerequisite assertion. Preserve `--extra speech` across shared-environment uv commands as documented in the runbook.

## Integration findings and cleanup

B4 exposed a real Stop/abort WebSocket race: the terminal acknowledgement could raise `WebSocketDisconnect` after the browser closed. The review chat reproduced and fixed disconnect/OSError/closed-socket/timeout terminal sends while preserving capture release. Both real-speech tests passed after that fix without the prior ASGI exception. Other review changes cover idempotent cancellation cleanup and request/identity ownership; details and production file paths are in its handoff. B4 itself edited no production runtime component.

Success demonstration: run B4 fixture server/browser config, choose Live backend + mock, Start, observe first drawing during paused generation, then Reset to clear board/advance epoch/release capture. Failure demonstration: run the scene malformed-EOF browser test; completed objects survive and a transport diagnostic replaces false completion. The reverse-proxy test holds completion behind a gate until the first operation is observed. Its local proxy is tested; deployed nginx/CDN buffering is not. Use `deployment/probe_streaming.py` against the paused fixture behind the real proxy before deployment acceptance.

All listeners close sockets and join worker threads; the restart test terminates its child in `finally`; model tests close registry/worker resources; measured draw composition unmounts React, disposes scene/viewport/consumer, and deletes its backend session. Generated WAVs/model binaries are ignored. No secrets were written to artifacts.

## Exact B4 changed paths

Final orchestration subsequently completed the entire strengthened B4 browser gate: **10/10 passed in 55.0 seconds**, including both server-issued Vosk profiles and actual speech Konva draws. Reports are preserved as `benchmarks/backend/verified-speech-vosk-us-small.json`, `verified-speech-vosk-india-small.json` and `verified-browser-draw.json`. See [coordinated verification](backend-B4-orchestration.md) for final combined results, intermediate failures and their resolutions, and the distinction between baseline timings and final correctness-run samples.

Backend checkout:

```text
.gitignore
.github/workflows/backend.yml
README.md
backend/pyproject.toml
backend/tests/__init__.py
backend/tests/integration/__init__.py
backend/tests/integration/listener.py
backend/tests/integration/fixture_server.py
backend/tests/integration/test_acceptance.py
backend/tests/integration/test_audio_network.py
backend/tests/integration/test_provider_matrix.py
backend/tests/integration/test_proxy.py
backend/tests/integration/test_speech_profiles.py
benchmarks/backend/generate-speech.ps1
benchmarks/backend/generate-speech-linux.py
benchmarks/backend/fixtures/technical.json
benchmarks/backend/run.py
benchmarks/backend/provider-smoke.py
benchmarks/backend/provider-smoke.json
benchmarks/backend/measured-windows.json
benchmarks/backend/measured-browser.json
deployment/nginx.streaming.conf
deployment/probe_streaming.py
docs/backend-B4-runbook.md
docs/agent-handoffs/backend-B4.md
```

Frontend checkout:

```text
package.json
tests/backend-e2e/acceptance.browser.spec.ts
tests/backend-e2e/contracts-runner.mjs
tests/backend-e2e/contracts.test.ts
tests/backend-e2e/vitest.config.ts
tests/backend-e2e/playwright.config.ts
tests/backend-e2e/harness.ts
tests/backend-e2e/drawHarness.ts
tests/backend-e2e/draw.browser.spec.ts
tests/backend-e2e/restart.browser.spec.ts
tests/backend-e2e/scene.browser.spec.ts
tests/backend-e2e/speech.browser.spec.ts
tests/backend-e2e/resample.ts
```

Generated local-only audio: `benchmarks/backend/fixtures/technical.wav` and `technical-16k.wav` (ignored). Playwright JSON/traces are generated output, not application source. The backend is not a Git repository; no commit or diff claim is made for it.
