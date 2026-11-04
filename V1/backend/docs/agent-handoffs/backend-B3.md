# B3 handoff — 2026-11-03

B3 implements sessions, HTTP event streaming, cancellation/replay, and the frontend network bridge. Work stops before B4. The master plan is a scope reference; its parallel execution/later-stage instructions do not override the user's request to implement stages sequentially.

## Delivered behavior

- Server-generated unguessable session IDs, immutable approved speech/diagram profiles, pinned configuration fingerprint, epoch ownership and reset, idle expiry, session capacity and orderly shutdown.
- B1 audio service mounted with server-owned bindings, strict WebSocket origins, one capture connection, old-epoch rejection and bounded used-stream identities. Audio/transcription can continue during diagram generation.
- B2 domain results mapped to validated NDJSON wire events. Server-owned sequences begin at one; started, warnings, operations and exactly one terminal event are persisted before delivery. No provider-specific route logic or backend canonical scene.
- Pre-header request/provider validation; no-cache/no-transform and no-buffer headers; incremental response delivery and disconnect monitoring over actual TCP.
- One active generation per session, request fingerprints over normalized sorted JSON, identical duplicate replay without provider invocation, 409 conflicts, subscriber limits and atomic retained-log/live-tailing under one condition lock.
- Bounded retained bytes with terminal reserve, pending-event limits, TTL cleanup and bounded tombstones. Expired/unknown replay returns 410; IDs cannot silently regenerate within the same session. Capacity failures preserve validated prefix events.
- Immediate idempotent explicit cancellation; disconnect cancels only when no reader remains after a 100 ms reconnect window. Cancellation closes the per-request provider iterator; reset/delete also cancel audio. Shutdown closes sessions before shared providers.
- Typed fetch adapter with fatal UTF-8 decoding, bounded records, identity/revision/sequence checks, EOF interruption, original replay metadata, reader cleanup and bounded explicit cancel on fetch abort. No repair, renumbering, automatic retry or model fallback.
- Lazy capability discovery, approved profile selection, session creation/restart reconciliation at the current browser epoch, lifecycle invalidation and audio source composition. Standalone mock makes no backend requests.
- Existing session controller remains the sole transcript scheduler. Final speech is grouped by its existing delay; context is captured after connection and immediately before each new request. Same-ID retry reuses the original request; explicit fresh continuation gets a new ID and current board context. No duplicate app shell or scene store.

## Endpoints and compatibility

| Method | Path | Ownership/result |
| --- | --- | --- |
| POST | `/api/v1/sessions` | Optional `sessionEpoch`, `profile`, `diagramProfile`; returns 201 identity |
| GET | `/api/v1/sessions/{sessionId}` | Current `sessionEpoch` query; 410 after expiry/restart |
| DELETE | `/api/v1/sessions/{sessionId}` | Current epoch; idempotent 204 for unknown session |
| POST | `/api/v1/sessions/{sessionId}/reset` | `{sessionId,sessionEpoch}`; increments epoch and ends old work |
| WS | `/api/v1/sessions/{sessionId}/audio` | Origin plus B1 start handshake with current profile/epoch |
| POST | `/api/v1/generations` | Existing full-context request; NDJSON or preflight error |
| POST | `/api/v1/generations/{requestId}/cancel` | `{sessionId,sessionEpoch}`; idempotent terminal response |
| GET | `/api/v1/generations/{requestId}/events` | `sessionId`, `sessionEpoch`, optional `after`; retained suffix/live tail |

`SessionCreate.sessionEpoch` is an optional additive contract field (default zero), needed when a restored/imported frontend already has a later local epoch. It does not change existing session ownership. The generated session-create schema is synchronized. Operation, generation-event and audio formats remain v1. Readiness/capabilities now report B3 and all network service flags true. The earlier B0/B1/B2 handoffs are historical snapshots.

Use a loopback backend plus the sibling frontend. Select Live backend, select an available approved speech profile, then Start. Default backend URL is `http://127.0.0.1:8000`; override with `VITE_WHITEBOARD_BACKEND_URL`. Origins must match server configuration. See the root README for setup and recovery controls.

## Validation

- Backend: 216 passed, five explicitly opt-in credentialed provider tests skipped. Includes real TCP early delivery, disconnect cancellation, identical replay and provider call-count assertions; ownership, epochs, expiry, retention/backpressure, audio mounting and sequence checks.
- Backend Ruff lint/format and nine generated schema/fixture drift checks passed.
- Frontend: 265 unit tests passed; typecheck, lint, formatting and production build passed. Checks cover split UTF-8/NDJSON, malformed/missing terminals, metadata conflicts, suffix replay, abort cleanup, expiry/restart, superseded connections, current-context continuation and the existing standalone suite. Vite reports the existing large application chunk advisory.
- B3 browser component check passed with a real listening backend and deterministic synthetic PCM: WS speech → scheduler → HTTP generation → canvas, observed nodes before completion, reset epoch/capture cleanup. It uses mock providers and does not request microphone permission or use credentials.
- All seven standalone session browser regressions passed. The old default-demo assertion was aligned with the existing seven-segment final-only tour and its current section titles/duration; production mock fixtures were unchanged. Backend browser checks have a separate server configuration and are excluded from the standalone-only runner.

Commands from backend root:

```powershell
uv run --project backend pytest -q
uv run --project backend ruff check backend
uv run --project backend ruff format --check backend
uv run --project backend python backend/scripts/export_protocol.py --check --frontend-root ../rendering
```

Commands from frontend root:

```powershell
npm run check
npm run test:session-browser
npx playwright test --config src/session/backend/playwright.config.ts
```

## Boundaries for B4

Sessions/replay are in-memory, single-worker, loopback only. Terminal replay is retained for five minutes by default; a backend restart requires a new identity while the browser keeps the drawing. Four readers, 4096 request identities and 4096 audio identities cap each session; reconnect explicitly when identity limits are reached. A retained failure cannot become successful by replaying it.

No deployment/proxy acceptance suite, production multi-worker persistence, latency benchmark, real-microphone accuracy evaluation, new Vosk model download or paid live-provider verification was performed for B3. B4 owns those cross-system acceptance tests and measurements. Existing B1/B2 optional model/provider tests are preserved. Upstream billing cancellation remains unknown; local connection cancellation is not a billing guarantee. Starlette's existing httpx TestClient deprecation warning remains; dependency migration is outside this stage.
