# B0–B3 independent review fixes — 2026-11-03

Scope: review existing production components and fix verified defects while B4 owns integration tests, browser acceptance, benchmarks, deployment assets, root README and CI/package wiring. No worktree, dependency update, schema revision, paid request or model download was performed. No applicable AGENTS.md was found in either checkout or their C:/Work parent.

## Fixes

1. **Idempotent cancellation preserves provider cleanup.** `SessionRegistry.cancel` previously called `task.cancel()` even when its record was already terminal. A second cancel injected another cancellation into the provider's asynchronous cleanup. The new regression failed before the fix with cleanup incomplete. Cancellation now signals the producer only when it actually transitions the retained record to cancelled. A follow-up shutdown audit found that the registry's global task sweep could also re-cancel a producer already closing after Stop/reset. All registry task cancellation now passes through a Python 3.10-compatible guard that remembers cancellation until task completion and removes the reference afterward. Regressions cover cancel followed by cancel, reset, delete or shutdown, checking cleanup completion, one retained terminal and removal of the tracking reference.
2. **Late HTTP failures cannot invalidate a newer browser session.** The HTTP generation transport now includes the original request in its local error callback. The bridge handles session-expired/stale-epoch errors only when both the request's session ID and epoch match its current identity. A deferred old-epoch HTTP 409 after successful remote reset leaves the new identity ready and does not stop its capture.
3. **Connection replacement retires obsolete remote identities before consuming replacement capacity.** Capacity-one fake-server regressions reproduced HTTP 429 for different-epoch replacement and immediate Start after profile selection. Different-epoch connection now awaits deletion of the obsolete identity before POST. Profile selection stores an asynchronous retirement barrier that the next connection awaits. Ordinary same-epoch reconnect still checks the existing identity first, and a temporary HTTP 503 does not DELETE it or create a replacement. Restart recovery also best-effort deletes the prior identity after successful replacement. DELETE targets the prior ID/epoch and remains bounded by the existing three-second timeout.
4. **Temporary reconnect failure retains the browser's recoverable identity.** Extending the 503 regression through the next Start reproduced a further gap: the catch path cleared the only browser ID even though the server session had not been deleted. It now retains the prior same-epoch identity in error status until a successful GET revalidates it. The capacity-one fake rejects additional POSTs; the regression proves the second Start succeeds by GET with the same identity and only one lifetime POST. Four negative cases verify stale (409), expired (410), different-epoch and explicitly profile-retired identities remain cleared if replacement POST fails with 503. Capture still requires ready status, so retaining the ID does not authorize audio before revalidation.
5. **Stop/disconnect races cannot escape the abort acknowledgement handler.** B4's real-speech browser run exposed an uncaught WebSocketDisconnect when Stop sent abort and immediately closed the browser socket. A focused ASGI WebSocket regression reproduced failures for disconnect, OSError, closed-socket RuntimeError and send timeout. The abort terminal acknowledgement is now best effort using the same exception handling as error termination. Capture closes and releases ownership, and a failed acknowledgement marks the connection disconnected so cleanup does not send a second close. This does not suppress capture/provider errors outside that terminal send.
6. **Existing stale-label browser acceptance waits for its fixture gate.** The orchestrator authorized this specific existing `tests/e2e/acceptance.spec.ts` correction after its combined gate reported generation stuck streaming. The targeted test reproduced the five-second assertion timeout. Its single synchronous page evaluation submitted a request, edited the label and called `release` before the typed fixture adapter had advanced beyond its started event into the raw generator that installs the gate. The test now polls for the fixture's captured request before editing/releasing. The request snapshot therefore precedes the manual edit, and the release callback exists. No runtime change or timeout increase was necessary; the test still asserts the manual label survives and exactly one stale operation is rejected.

## Exact changed paths

- `C:/Work/backed/backend/app/sessions/registry.py`
- `C:/Work/backed/backend/app/sessions/test_registry.py`
- `C:/Work/backed/backend/app/speech/socket.py`
- `C:/Work/backed/backend/app/speech/test_socket.py`
- `C:/Work/rendering/src/stream/backend/transport.ts`
- `C:/Work/rendering/src/session/backend/bridge.ts`
- `C:/Work/rendering/src/session/backend/bridge.test.ts`
- `C:/Work/rendering/tests/e2e/acceptance.spec.ts`
- `C:/Work/backed/docs/agent-handoffs/backend-review-fixes.md`

No wire contract, JSON Schema, endpoint, request/event shape, dependency or shared Python/TypeScript fixture changed. The optional internal `HttpGenerationTransport` constructor error callback now receives `(error, request)`; callbacks accepting only the error remain compatible. B4-owned files were not edited.

## Verification

From `C:/Work/backed`:

- `.venv/Scripts/uv.exe run --project backend pytest -q backend/app/sessions/test_registry.py -k repeated_cancel`: reproduced the new cleanup regression before the production fix (one failed).
- `.venv/Scripts/uv.exe run --project backend pytest -q backend/app/sessions backend/app/api`: **13 passed** after the final shutdown guard, including four cancellation lifecycle regressions and the existing ephemeral-port real TCP delivery/disconnect/replay check.
- `.venv/Scripts/uv.exe run --project backend pytest -q backend/app`: **194 passed, five skipped** before the final shutdown guard/three additional cancellation cases. The skipped cases are opt-in credentialed provider tests. The final focused suite above covers the subsequent change; no broad sweep was repeated during B4's measurements. Existing Starlette/httpx TestClient deprecation warning remains.
- `.venv/Scripts/uv.exe run --project backend ruff check backend/app/sessions`: passed.
- `.venv/Scripts/uv.exe run --project backend ruff format --check backend/app/sessions`: passed (four files).
- `.venv/Scripts/uv.exe run --project backend pytest -q backend/app/speech/test_socket.py -k acknowledgement`: **four failed before the abort acknowledgement fix**, reproducing the reported terminal-send race and its equivalent failure modes.
- `.venv/Scripts/uv.exe run --project backend pytest -q backend/app/speech backend/app/sessions backend/app/api`: **48 passed after the final socket fix**, including all four terminal-send failure regressions. No models or paid providers were invoked by this command.
- `.venv/Scripts/uv.exe run --project backend ruff check backend/app/speech/socket.py backend/app/speech/test_socket.py` and corresponding `ruff format --check`: passed (two files).

From `C:/Work/rendering`:

- `npx vitest run src/session/backend/bridge.test.ts src/stream/backend/transport.test.ts`: **19 passed** before three additional capacity/reconnect cases.
- `npx vitest run src/session src/stream/backend src/audio/backend`: **52 passed** across six files after the final transient-reconnect recovery change.
- `npm run typecheck`: **passed after the final transient-reconnect recovery change**. An intermediate run found errors in B4's concurrently authored `tests/backend-e2e/scene.browser.spec.ts`; that owned file was left untouched and the orchestrator was informed. Those errors were no longer present on the final run.
- `npx eslint src/session/backend/bridge.ts src/session/backend/bridge.test.ts src/stream/backend/transport.ts --max-warnings 0`: passed after correcting a multiline test expression flagged by ESLint.
- `npx prettier --check src/session/backend/bridge.ts src/session/backend/bridge.test.ts src/stream/backend/transport.ts`: passed.
- `npx playwright test tests/e2e/acceptance.spec.ts -g '03 stale' --output C:/Work/rendering/.cache/review-e2e`: reproduced the original streaming timeout before correcting test ordering.
- The same targeted browser command with `--repeat-each 3`: **three passed** after the correction, with no timeout increase.
- `npx playwright test --output C:/Work/rendering/.cache/review-e2e`: **all 18 default Chromium e2e tests passed (1.0 minute)** after the fixture-ordering correction. Output stayed in the isolated review directory; no B4/root artifacts were cleaned.
- `npx eslint tests/e2e/acceptance.spec.ts --max-warnings 0` and corresponding `npx prettier --check`: passed.

## Reviewed behavior requiring no change

- Session/request fingerprint ownership, active generation exclusion and persisted-before-delivery sequence assignment.
- Retained prefix plus terminal reserve under bounded retention, bounded request/audio identity tombstones, expiry and actionable 410 responses.
- Replay snapshot/live tail under the same session condition; subscriber closure and reconnect-window orphan cancellation.
- HTTP and WebSocket Origin rejection at the ASGI boundary, bounded request bodies and non-public capability serialization.
- Audio epoch/stream identity checks and worker ownership; reset/delete cancel capture separately from generation.
- Browser transcript scheduler/context capture remains the existing controller's responsibility. Pause intentionally retains rejected flush transcript in the speech source for resume.

These findings are supported by source inspection and the existing component tests above; they are not a claim of exhaustive security or browser/deployment validation.

## Demonstrations and limitations

- Recovery success: start a backend identity, begin a generation whose HTTP error is delayed, reset to the next epoch, then release the old stale-epoch error. The replacement remains ready; its capture is not stopped.
- Cancellation failure regression: gate a provider's asynchronous cleanup, cancel once, cancel again while cleanup is waiting, release the gate. Cleanup completes and the retained stream contains only started/cancelled.
- No paid live-provider behavior, actual microphone accuracy, proxy behavior, performance measurements or full B4 integration gate was run here. The targeted stale-label regression and all 18 tests in the default existing Chromium e2e suite were run in this review chat. B4 and the orchestrator own other browser configurations and broader checks.
- Remote identity deletion remains best effort with the existing three-second timeout; a failed deletion falls back to backend idle expiry. Sessions remain bounded in-memory/single-worker as documented by B3.
