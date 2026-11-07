# Agent 8 handoff

## 1. Completed components

Implemented all twelve integrated acceptance journeys, protocol/failure fixtures, document export/import/autosave composition, Firefox/WebKit smoke coverage and controlled performance collection with actual Konva draws and Chromium timeline evidence. Functional tests pass. The measured <50 ms p95 streaming target is not consistently met and remains an explicit open release gate; this handoff does not declare every performance target achieved.

The app now restores saved drawing data before editing, exposes local save status/Save now and confirmed file import, preserves drawing on invalid/stale files and never persists transcript/audio. No credentials or provider dependency were added. Default/mock journeys fail if HTTP leaves localhost. No publication, remote CI execution or license selection was performed.

## 2. Exact public exports and usage

src/app/documentController.ts exports createDocumentController(store, persistence?) and MAX_DOCUMENT_BYTES (8 MiB). Methods: getSnapshot, subscribe, exportText, importText(text, confirmed), importFile(file, confirmed), restore, flush and dispose. It borrows SceneStore and owns optional autosave/persistence lifecycle. RendererRuntime now exposes document. RendererRuntimeOptions adds optional persistence, transport and speech injection alongside contextBudgetBytes.

```ts
const runtime = createRendererRuntime({ persistence: createIndexedDbPersistence() });
await runtime.document.restore(); // Before presenting editing controls.
// runtime.document.exportText();
// await runtime.document.importFile(file, true); // Only after UI confirmation.
// await runtime.document.flush();
// runtime.dispose();
```

Owned fixture/harness APIs under tests are deliberately not production barrels. Performance and cross-browser commands are documented in [acceptance](../acceptance.md) and [performance](../performance.md). Existing GenerationRequest/Scene schemas and controller contracts are unchanged.

## 3. Files and shared decisions

- Added tests/fixtures/protocol.ts for all shapes/branching/relative placement/correction/duplicate/disorder/Unicode/topic cases and fixed dense performance scenes.
- Added tests/e2e acceptance/recovery files and an isolated full-runtime harness. Scenario 5 is parameterized at two zoom levels. tests/harness.html avoids mounting an unrelated hidden app. Harness remounts unmount prior React/runtime resources.
- Added tests/performance harness/config/spec and versioned JSON measurements; added tests/cross-browser Firefox/WebKit smoke config/spec. Performance reports separate record arrival, commit, dispatcher/layout, actual draw, isolated decoder/schema, cached/uncached routing, collision placement and navigation/rAF proxy. Raw Chromium trace JSON is emitted with each run.
- Added documentController and unit tests; App injects IndexedDB and awaits restore. DocumentPanel provides status/recovery, Save now and JSON files. File import is byte-bounded, confirmed and rejects a stale async read. Core persistence/schema/session replacement APIs retain authority.
- Scene equality now uses identity-first structural comparison instead of sorting/stringifying full records repeatedly. Deterministic replay signatures still use stable serialization. Existing immutability/reference/history/replay tests all pass; no schema validation shortcut was introduced.
- Developer request IDs add epoch after import/reset, avoiding tombstoned IDs even after restored fixtures. This regression has an integrated test.
- Added test:performance, test:cross-browser and test:browser-all; browser installer/CI now include all three engines. CI runs all functional suites, collects benchmark reports and uploads artifacts. Default benchmark checks workload integrity; WHITEBOARD_PERFORMANCE_GATE=1 additionally enforces <50 ms p95 on a chosen reference environment.
- No dependencies/lockfile changes. npm ci --no-audit was rerun successfully with the existing lockfile. Matching Firefox/WebKit browser binaries were installed for local smoke tests.

## 4. Tests and actual outcomes

Validated on 3 November 2026, Windows, Node 22.17.1/npm 10.9.2.

| Command                               | Actual outcome                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| npm ci --no-audit                     | Passed; 188 packages installed from lockfile                                                     |
| npm run check                         | Passed: strict types, zero-warning lint, formatting, 228 unit tests / 21 files, production build |
| npm run test:e2e                      | Passed: 17 Chromium startup/acceptance/recovery cases                                            |
| npm run test:scene-browser            | Passed: 1 IndexedDB test                                                                         |
| npm run test:layout-browser           | Passed: 1 real-font/layout test                                                                  |
| npm run test:board-browser            | Passed: 11 navigation/rendering cases                                                            |
| npm run test:editor-browser           | Passed: 12 manual/native-editing cases                                                           |
| npm run test:stream-browser           | Passed: 3 stream/fault/retry cases                                                               |
| npm run test:session-browser          | Passed: 7 session/recording cases                                                                |
| npm run test:ui-browser               | Passed: 9 responsive/accessibility cases                                                         |
| npm run test:cross-browser            | Passed: Firefox and WebKit smoke, 1 each                                                         |
| performance spec with --repeat-each 3 | Passed workload/draw-count/culling integrity in all 3 runs; latency target met in only 2 of 3    |

Total: 228 unit tests, 61 Chromium functional tests, two additional-engine smoke cases and three measured benchmark executions. All 225 prior unit tests remain passing. Native drag/touch/IME/media cleanup remain covered by the earlier suites; precise integration races sometimes invoke public editor/session APIs in the full product harness. CI configuration is updated but remote CI has not run.

Reference machine: i5-13500H, 16 reported logical CPUs, about 15.6 GiB RAM, Windows build 26200 x64; headless Chromium 156.0.8078.4, DPR 2. Three final 500-visible-node/30-op/s trials yielded operation-to-draw p95 of 49.3, 47.5 and 54.0 ms. Dispatcher p95 was 7.0–7.9 ms. Fifty-section navigation with 5,000 total nodes rendered only 100 in the final view and measured 19.2–19.4 ms p95 input-to-draw. The navigation rAF proxy averaged about 60 FPS; physical gesture/paint FPS is unverified. See the full measurement limits and raw trials in performance.md.

Production bundle remains approximately 801 kB minified JS / 245 kB gzip, with Vite's >500 kB warning. The early profile showed 168.2 ms draw p95 and 22.6 ms dispatcher p95; harness/warmup changes also affect before/after comparison, so no exclusive causality or universal speedup is claimed.

## 5. Reproduction and final integration review

Run npm ci, npm run test:e2e:install, npm run check and npm run test:browser-all. Run npm run dev for Start demo, manual editing, local recording preview and Document files/autosave. Save status indicates whether the latest debounced edit reached local persistence. Export a JSON file for a portable backup; import requires confirmation.

Run npm run test:performance for report/trace artifacts, or repeat the performance spec three times as documented. The reference files preserve all trials, including the miss; they are not automatically rewritten by tests. Full acceptance mapping and the precise boundary between native and controller-driven interactions are in acceptance.md.

Agent 0/final review should assess the remaining repeatable latency/bundle targets, physical gestures/assistive/audio-device QA and licensing before public release. Do not silently change UNLICENSED, connect provider endpoints, upload audio or publish. Functional integration and all handoffs now exist; a production release is not declared ready solely from this QA pass.

## 6. Known limitations and open gates

The streaming latency gate misses in one of three final trials; further profiling/optimization remains. Full-scene cloning/schema validation and development/tracing overhead still contribute. Dense benchmark uses rectangular nodes without an edge-heavy visual mix. Physical pointer-gesture/screen-paint FPS, hours-long memory soaks, physical device removal and full Firefox/WebKit acceptance/accessibility are unverified. Smoke fallback/navigation passed on both additional engines.

Autosave is local and debounced; abrupt close can lose edits still waiting to save, and origin storage can be unavailable/evicted. No guaranteed unload flush, transcript/audio persistence, cloud sync or real STT/model backend is implemented. The app exposes storage errors and explicit export/retry. Session name remains local display state.

Existing bundle warning and earlier development dependency audit findings remain open; no new audit was performed during the reproducibility install. License remains UNLICENSED pending the owner's decision before public release. No Git remote, commit, PR, deployment or publication was created.
