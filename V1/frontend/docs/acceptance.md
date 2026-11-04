# Integration acceptance

Agent 8 implements the twelve master-plan journeys in tests/e2e/acceptance.spec.ts. The fifth journey runs at both 50% and 200% zoom, giving thirteen acceptance cases. The product startup and three recovery cases bring npm run test:e2e to seventeen Chromium tests. Existing scene/layout/board/editor/stream/session/UI suites remain in CI.

The integration harness renders the full WhiteboardApp with the real runtime, scene/layout/editor/context/session/stream layers and deterministic injected speech/transport sources. Some manual commits and camera setup use public controller APIs to isolate concurrency precisely; the existing editor/board suites separately exercise native pointer, resize, drag/drop, touch and IME behaviour. The harness HTML mounts exactly one runtime and unmounts it before remounting, rather than leaving a hidden application behind.

| Journey              | Checked result                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Start demo        | Browser, Server and Request commit in order; the actual scene-layer draw reaches revision 4 before transport ends.                                                                              |
| 2. Manual context    | Pause input; insert/name/move/resize manual Database; resume. The next immutable request includes x/y/width/height exactly, and Query references its canonical manual ID.                       |
| 3. Stale correction  | Manual label change after request creation survives stale streamed update; rejected operation is counted.                                                                                       |
| 4. Topic navigation  | Explicit topic generation follows; navigation suspends follow. Later operations preserve browsing position, allowing only required section-origin anchor compensation. Resume live is explicit. |
| 5. Pointer insertion | Rectangle insertion at 50% and 200% after pan maps to the pointer's world position.                                                                                                             |
| 6. Grid              | Repeated toggles leave canonical geometry and scene revision identical.                                                                                                                         |
| 7. Disorder/Unicode  | Edge arrives before endpoints, all six shape types render, CRLF/final line work with 1–3 byte chunks, Unicode survives, correction applies and duplicate addition remains a no-op.              |
| 8. Late reset        | An injected transport ignores abort; releasing late chunks after confirmed reset cannot repopulate the scene.                                                                                   |
| 9. Permission denial | Denied microphone enters an actionable error while manual insertion and mock mode remain available.                                                                                             |
| 10. History          | Delete cascades edges; undo restores them. Subsequent topic generation survives redo/undo of the manual deletion.                                                                               |
| 11. Files            | Export through the browser download UI; import that file after reset; complete canonical scene, geometry, IDs, labels and sections match.                                                       |
| 12. Reflow           | Growing an earlier section preserves at least the 160-unit section gap and compensates the downstream camera anchor at its current scale.                                                       |

Protocol fixtures live in tests/fixtures/protocol.ts: all shapes, relative placement, branching, correction, duplicate add, missing-order dependency, Unicode and explicit next topic. They contain no credentials or external network dependencies. Acceptance tests intercept HTTP requests and fail if any request leaves localhost/127.0.0.1, including a model/STT endpoint. No real provider is used.

Recovery coverage additionally checks saved drawing reload, rejected JSON import without data loss, malformed line plus unresolved dependencies, stalled-read cancellation and explicit retry availability. Debug request prefixes include epoch after import/reset, preventing reuse of tombstoned IDs. Existing stream/session tests cover size/queue limits, context overflow, failed partial retry, external abort and microphone cleanup. Unit suites retain reducer/schema/geometry/history/context coverage.

Firefox and WebKit each pass a smoke journey covering keyboard insertion, zoom/grid and microphone-denial/unsupported fallback followed by permission-free mock mode. Their matching Playwright browser builds are installed by CI; local users can run npx playwright install firefox webkit. Full Chromium acceptance is not claimed for those engines.

## Document composition

src/app/documentController.ts wraps existing scene import/export/autosave APIs. The real app creates IndexedDB persistence and awaits validated restore before showing editing controls. Harness runtimes omit persistence by default. Only canonical Scene JSON is saved: no transcript, undo history, request state or audio. DocumentPanel exposes save status, explicit Save now, Export document and confirmed Import document.

Imports are capped at 8 MiB before file reading and again by actual UTF-8 text size. Async reads are rejected if drawing changed meanwhile. Invalid files preserve scene/history/session; successful imports use store.importScene, invalidating old requests and resetting editor/session state through existing replacement hooks. Export is a user-triggered JSON download with a revoked temporary URL. Current drawing persists after a successful save across reload.

Autosave remains debounced; wait for Saved on this device or use Save now before closing. Abrupt shutdown before a save completes can lose the newest unsaved changes. Storage failure keeps drawing available and exposes retry/export recovery. Disposing the runtime cancels pending save timers and closes persistence; it does not claim a durable asynchronous unload flush. A portable exported file is independent of origin/browser storage.

Run npm run check, npm run test:e2e and the owned browser scripts listed in README. npm run test:cross-browser exercises the two additional engines. Performance collection and its unmet/repeatability limits are documented separately in [performance results](performance.md). Passing functional tests does not mark every performance or public-release gate complete.
