# Architecture and foundation decisions

## Current implementation

src/main.tsx installs shared theme variables and mounts React StrictMode with an error boundary. src/app/App.tsx waits for fonts, creates one store/layout/camera/session/document runtime, restores validated IndexedDB drawing data and composes WhiteboardApp. The RendererApp compatibility export keeps existing integration harnesses working. Harness runtimes omit persistence unless explicitly injected.

src/contracts publishes schema-derived canonical types. src/scene owns transactions/history/concurrency/persistence; src/layout supplies metrics, placement/reflow, routes and transforms. These modules do not import React/Konva. src/board provides rendering/navigation; src/editor owns manual tools and transient editing. src/stream owns bounded parsing/scheduling and mock transport. src/session coordinates final transcripts, requests and recovery; src/context builds full budgeted immutable requests; src/audio provides mock speech, bounded local preview and the future transcription boundary. src/ui composes the responsive shell and keyboard alternative; src/styles supplies shared theme tokens. Agent 8 adds document composition, acceptance/failure fixtures and measured performance. Default generation/transcription remain mocked.

## Ownership map

| Owner | Paths                                              | Responsibility                                               |
| ----- | -------------------------------------------------- | ------------------------------------------------------------ |
| 0     | Root config, package files, `src/app`, CI          | Foundation, composition, integration and release             |
| 1     | `src/contracts`, `src/scene`                       | Schemas, canonical scene, transactions, history, persistence |
| 2     | `src/layout`                                       | Measurement, placement, sections, connectors and transforms  |
| 3     | `src/board`                                        | Konva renderer, viewport and navigation                      |
| 4     | `src/editor`                                       | Tools, selection, gestures and text editing                  |
| 5     | `src/stream`                                       | UTF-8/NDJSON framing, scheduler and transport                |
| 6     | `src/session`, `src/context`, `src/audio`          | Session lifecycle, immutable context and speech adapters     |
| 7     | `src/ui`, `src/styles`                             | Product UI, theme and accessibility                          |
| 8     | `tests/e2e`, `tests/fixtures`, `tests/performance` | Integration acceptance, fixture data and measurements        |

## Intended data flow

Final mock transcript → session coordinator → fresh immutable scene context → injected generation transport → NDJSON consumer → validated dispatcher → canonical scene → layout/rendering.

Manual tools use the same dispatcher. UI state and transient gesture previews stay separate from document state. Layout is injected into scene application; the scene layer must not import React or Konva. Agent 0 will compose one store/controller instance and inject adapters after those public APIs exist.

The preserved master plan contains full requirements. [Protocol v1](protocol.md) documents the executable baseline. [Layout integration](layout.md) describes the production adapter and Agent 3's renderer boundary. Shared changes remain coordinated by Agent 0. Production browser composition awaits shared font readiness, injects createLayoutEngine, and owns one scene/controller lifecycle.

[Board integration](board.md) describes camera APIs, native input arbitration, DPI, draw-completion instrumentation and Agent 4's ref/preview/overlay contract. Exactly three canvas layers are used. The canonical store is the only persistent state; navigation, selected IDs, grid and previews are external UI state. Agent 3 corrected viewport validation to accept finite screen-pixel translations independently of world-coordinate limits.

[Editor integration](editor.md) describes the controller, label/Transformer bridge and request-deferral flag. Runtime owns one editor per store. getReplacementVersion changes on successful import/reset so UI drafts cancel even when IDs/revisions match; generation cancellation preserves them.

[Stream integration](stream.md) describes Agent 5's bounded decoder, 8 ms cooperative frame scheduler, observable consumer and seeded GenerationTransport mock. The runtime disposes its consumer before the editor/store. Session invalidation subscriptions immediately abort stalled requests. Explicit retry retains accepted receipts and original request identity.

[Session integration](session.md) describes the coordinator, 400 ms grouping/final-ID deduplication, backpressure, context budget/inspector and local capture lifecycle. The app composes one session controller over the existing stream consumer and disposes it first. streamPreview remains a developer regression control using the same budgeted context builder. Microphone clips are complete short recordings with a 60-second/8 MiB rolling bound; audio never enters scene/request JSON. Separate capture/generation axes drive the product status bar and session details.

[UI integration](ui.md) describes the implemented compact shell, responsive Board panel, keyboard insertion/connectors/outline, focus management and shared theme. The old SessionPanel scaffolding was removed. UI writes use public controller callbacks; scene records remain canonical and immutable. Developer tools are collapsed, capture/generation labels are separate and diagnostics use raw state attributes for tests alongside readable status text. Theme tokens now drive both canvas paint/typography and DOM variables.

## Toolchain decisions

- Resolve dependencies through npm without bypassing peer checks; commit the lockfile for reproducibility.
- Use the TypeScript 6.0 line because the generated template's TypeScript 7 is outside the current typescript-eslint supported peer range. ESLint and its plugins use mutually compatible published versions; Node type definitions match the supported Node 22 runtime.
- Strict TypeScript includes unchecked indexed access and exact optional properties.
- Vitest uses Node for framework-independent core tests. Playwright uses Chromium for the initial browser smoke; Firefox/WebKit journeys are a later QA step.
- Agent 1's browser persistence test lives beside its source and runs with npm run test:scene-browser, also included in CI. Vite pre-optimizes Zod/Zustand vanilla to avoid dependency-discovery reloads during dynamic integration imports.
- Agent 2's browser test runs with npm run test:layout-browser and verifies actual canvas metrics and shape attachments. CI includes it; no additional dependencies were installed.
- Agent 3's browser suite runs with npm run test:board-browser and includes 2× DPI, touch, navigation, follow/reflow, culling and cleanup. It is included in CI. Performance targets and Firefox/WebKit coverage are still unmeasured.
- Agent 4's browser suite runs with npm run test:editor-browser, included in CI, covering real editing, IME, stale generation and reflow during native resize. No extra dependencies were installed.
- Agent 5's browser suite runs with npm run test:stream-browser, included in CI, covering incremental canvas draw before transport completion, context reuse, cancellation and explicit fault retry. No extra dependencies were installed.
- Agent 6's browser suite runs with npm run test:session-browser, included in CI, covering full mock sessions, manual context/deferral, context overflow, reset and native local recording/cleanup with test media. No extra dependencies were installed.
- Agent 7's browser suite runs with npm run test:ui-browser, included in CI, covering responsive sizes, keyboard workflows, focus, toggle independence, hit areas and reduced motion. Theme contrast guards run in npm test. Lucide was already installed; no dependencies were added.
- Agent 8 expands test:e2e to all twelve acceptance scenarios and file/autosave/failure recovery. test:cross-browser covers Firefox/WebKit fallback/navigation. test:performance records actual Konva draws and trace evidence; its hardware-dependent 50 ms gate is opt-in and not consistently met on the reference machine. CI uploads reports/traces. See acceptance.md/performance.md.
- No Python virtual environment is needed: the future FastAPI boundary remains optional and unimplemented.
- No open-source license has been chosen. `UNLICENSED` is a temporary package declaration, not a release license decision.
