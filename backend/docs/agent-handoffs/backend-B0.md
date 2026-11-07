# B0 handoff — 2026-11-03

Initial foundation implemented; stopped before B1. Final integration duties assigned to B0 in the master plan remain dependent on future B1–B4 handoffs. They are not reported as completed here.

## Delivered and checklist

- [x] FastAPI application factory, lifespan, dependency injection, router composition and `AsyncExitStack` cleanup seam.
- [x] Python 3.10+ package, exact direct/build versions, universal uv lock with hashes, native setup/run documentation and CI definition.
- [x] Strict YAML/environment configuration, unknown-key rejection, profile/provider/format/limit validation, mock defaults and backend-relative model paths.
- [x] Explicit origins, loopback-only CLI binding, single worker, bounded HTTP request body and WebSocket origin enforcement.
- [x] Redacted configuration errors and safe capabilities. Missing optional weights/credentials do not prevent foundation startup or standalone frontend mock use.
- [x] Executable speech/LLM interfaces, typed provider errors, Pydantic wire contracts, nine generated JSON Schemas and shared valid/invalid fixtures.
- [x] Atomic frontend typed-event transport amendment, including mock adapter and tests; edge context includes mandatory source/lock/revision protection.
- [x] Health/capability endpoints and explicit nonfunctional session/generation/replay/audio stubs.
- [x] Windows local verification, schema drift checks, cross-language fixtures and browser mock streaming smoke tests.
- [ ] Model setup script, speech provider registry and audio transport: B1.
- [ ] Prompt/context budget service, incremental backend parser and mock/real LLM adapters: B2.
- [ ] Sessions, request pinning, cancellation/replay, HTTP/audio network adapters and capability discovery: B3.
- [ ] Wire the live-mode profile picker into existing UI after B1/B3 services exist; retain the current application shell. No selectable live mode is advertised by B0.
- [ ] Receive B1–B4 handoffs, integrate real audio/mock diagram, run all release gates and perform final B0 review.

The plan's section 7 says “seven” drawing operations but enumerates six. Existing frontend discriminants were preserved; a seventh operation was not invented.

## Public exports and routes

`app.main.create_app(settings=None, configure=None)` builds an isolated application. `get_settings` is a FastAPI dependency. The optional async `configure(app, stack)` hook lets later owners attach service instances to `app.state` and register shutdown callbacks on the exit stack. It runs before readiness becomes true; shutdown and failed startup unwind resources. No provider clients/tasks exist in B0.

`app.config`: `Settings`, `load_settings`, `ConfigurationError`, `BACKEND_DIR`. `Settings.model_path(profile)` resolves local models; `fingerprint()` hashes the effective configuration without secret values. `app.config.capabilities.public_capabilities()` serializes allowlisted metadata with no model paths, API-key references or raw options. All services/profiles are honestly unavailable in B0. Optional prerequisite failures are reported separately. B1/B2 must replace the placeholder availability checks with their registry's validated readiness.

`app.contracts` re-exports the provider protocols/data classes, normalized provider error, generation request/event/operation types and adapters, speech stream config/transcript/audio format, and session/error models. Detailed audio discriminated unions and PCM-frame validation are in `app.contracts.audio`. Serialization uses wire aliases and omits optional nulls. See `shared/protocol/README.md` for structural versus relational validation and transport semantics.

| Endpoint | B0 behavior |
| --- | --- |
| `GET /health/live` | 200, `{"status":"live"}` |
| `GET /health/ready` | 200 after lifespan starts; `stage: B0`, `servicesImplemented: false` |
| `GET /api/v1/capabilities` | 200, public profile metadata and version axes |
| `POST /api/v1/sessions` | Validates `SessionCreate`, then 501 |
| `DELETE /api/v1/sessions/{id}` | 501 |
| `POST /api/v1/sessions/{id}/reset` | Validates `SessionOwner`, then 501 |
| `POST /api/v1/generations` | Validates `GenerationRequest`, then 501 |
| `POST /api/v1/generations/{requestId}/cancel` | Validates `SessionOwner`, then 501 |
| `GET /api/v1/generations/{requestId}/events` | Requires `sessionId`, `sessionEpoch`, optional nonnegative `after`; then 501 |
| `WS /api/v1/sessions/{id}/audio` | Disallowed/missing Origin: 1008; allowed Origin: accepts then closes 1013, no transcript |

API error example: `{"error":{"code":"not_implemented","message":"Session service (B3) is reserved for a later backend stage."}}`. Invalid input uses 422 with a fixed safe message. Bodies beyond `server.max_request_bytes` return 413 before parsing. Defaults are a 512 KiB whole request cap and 256 KiB context budget; B2 must enforce the latter before opening any provider stream.

Example create request: `{ "profile": "mock" }`. Future response schema: `{ "sessionId": "s1", "sessionEpoch": 1, "profile": "mock", "diagramProfile": "mock", "configurationFingerprint": "…" }`; this is a contract example, not a fabricated session returned by B0. Full generation/audio/event examples are in `shared/protocol/v1/fixtures.json`.

## Files and cross-checkout decisions

Backend files:

- `backend/pyproject.toml`, `backend/uv.lock`, `backend/config/settings.example.yaml`, `backend/models/.gitkeep`.
- `backend/app/{__init__,__main__,main}.py`.
- `backend/app/config/{__init__,settings,capabilities}.py`.
- `backend/app/contracts/{__init__,base,operations,generation,audio,api,interfaces}.py`.
- `backend/scripts/{export_protocol,build_fixtures}.py`, `backend/tests/test_foundation.py`.
- `shared/protocol/README.md`, `shared/protocol/v1/{operation,generation-request,generation-event,audio-start,audio-client-message,audio-server-event,session-create,session-created,session-owner}.schema.json`, `shared/protocol/v1/fixtures.json`.
- Root `.gitignore`, `README.md`, `.github/workflows/backend.yml`, this handoff.

Coordinated changes in `C:/Work/rendering`:

- `src/contracts/schemas.ts`: required edge protections and `GenerationEvent` union; `GenerationTransport` yields typed events.
- `src/contracts/backend-fixtures.test.ts`, `tests/fixtures/backend-v1.json`: shared corpus snapshot and conformance tests. Snapshot drift is checked by backend exporter with `--frontend-root`.
- `src/context/index.ts`: captures exact committed edge protections.
- `src/stream/{rawFixture,mock,consumer,test-helpers}.ts`: raw fixture bytes stay inside the mock adapter, which validates/namespaces operations and emits envelopes. Consumer preserves original sequence/base revision/request/epoch, rejects bad metadata and missing/multiple terminals, and retains accepted prefixes on failure. Framing limits belong to the decoder/transport adapter, not the typed consumer.
- `src/stream/{mock,consumer,events}.test.ts`, `src/session/controller.test.ts`, `tests/e2e/browserHarness.ts`: migrated byte fixtures to typed adapters; added metadata/replay/terminal tests.
- `tests/performance/harness.ts`: arrival timestamps use event sequences including `started`; no benchmark was run or claimed.

Frontend render/layout/editor semantics are preserved. No HTTP client, audio capture adapter, second scene store or second transcript scheduler was added. Runtime already supports injected transports; B3 will supply real networking through that seam. Raw fixture parsing remains independently testable. Stream byte statistics now count serialized envelopes.

## Actual verification

Environment: Windows, Python 3.10.11, uv 0.13.7; dependencies resolved from the package registry and frozen during implementation. FastAPI 0.162.0, Pydantic 2.14.2, Uvicorn 0.54.0, PyYAML 6.0.3. Build backend Hatchling 1.33.0 was resolved and successfully built. Complete transitive versions/hashes are in `backend/uv.lock`.

- `uv sync --project backend --locked`: passed.
- `uv run --project backend pytest -q`: **23 passed**, including a real subprocess CLI server serving health/capabilities on a local port, API validation, cleanup, body bounds, CORS/WS origins, configuration and shared fixtures. One dependency deprecation notice: Starlette currently recommends `httpx2` over its supported `httpx` test-client path; tests pass with the frozen dependency set.
- `uv run --project backend ruff check backend`: passed.
- `uv run --project backend ruff format --check backend`: passed.
- `uv run --project backend python backend/scripts/export_protocol.py --check --frontend-root ../rendering`: passed, nine schemas plus fixture snapshot.
- Frontend `npm run typecheck`, `npm run lint`, `npm run build`: passed. Build reports a bundle-size advisory.
- Frontend changed-component suite: **70 passed** across stream/contracts/context/session tests.
- Frontend full `npm test -- --reporter=dot`: **234 passed, 1 failed**. The unchanged `src/audio/audio.test.ts:187` expects interim `demo-correction`/`demo-topic` fixtures from the default `MockSpeechSource`; its current default fixture emits finalized `tour-*` segments. Neither `src/audio/mock.ts` nor its test was edited in B0. This is recorded as an existing fixture mismatch, not hidden or repaired under B1 ownership.
- Frontend `npm run test:stream-browser`: **3 Chromium tests passed**: draw before completion, cancellation/retry, malformed/disconnected fixture recovery without duplicate objects.

Not run: macOS/Linux execution (CI definition only), the full browser/e2e matrix, model downloads or real Vosk, backend network streaming, provider conformance/live API calls, performance/accuracy benchmarks. Those depend on later stages; no latency, accuracy or live-provider claims are made.

## Demonstration and cleanup

Success: run `uv run --project backend python -m app`; visit `/health/ready` and `/api/v1/capabilities`. The foundation is ready without models/keys and reports unavailable future services. Run the frontend separately with `npm run dev`; its standalone fixture flow still draws incrementally through typed events.

Failure: POST `{}` to `/api/v1/sessions`: 501 `not_implemented`. POST a complete generation fixture with an edge's `locked` removed: 422 fixed validation error. This demonstrates the frozen backend-context amendment without pretending generation exists. A disallowed WebSocket Origin is rejected with 1008. Try `WHITEBOARD__TRANSCRIPTION__AUDIO__SAMPLE_RATE_HZ=48000`: startup fails with a redacted configuration error.

Ctrl+C stops the CLI. Async shutdown callbacks unwind in reverse registration order. Tests terminate the temporary listening subprocess. No provider streams, microphone tracks, model cache, session state, credentials or weights were created by B0. Virtual environments/caches and local settings/models are ignored. Continue with B1 only when explicitly requested.
