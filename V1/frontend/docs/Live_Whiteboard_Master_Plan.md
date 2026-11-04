# Live Whiteboard — Multi-Agent Implementation Master Plan

Status: implementation specification, v1. No application has been implemented by this document.

## Product goal

Help teachers, system designers, course instructors, YouTube mentors, and live presenters explain while a browser whiteboard provides immediate visual understanding. Prefer basic, readable, stable diagrams that keep up with speech. Render completed objects incrementally instead of waiting for a complete diagram.

The presenter can also insert, move, resize, label, recolour, connect, and delete objects manually. Automatic and manual changes must use the same scene model. Every generation request includes current whiteboard context, including actual object positions and dimensions.

## Scope and defaults

- Frontend: React, TypeScript, Vite, React Konva and Konva.
- Runtime validation: Zod; state: Zustand with a pure scene reducer; icons: lucide-react.
- Testing: Vitest for core logic; Playwright for browser interaction.
- Future backend: Python + FastAPI. V1 runs entirely in the browser without API keys or a Python process.
- V1 speech pipeline: deterministic transcript fixtures and an optional real microphone recording preview. Transcription and LLM generation are mocked. Do not imply that recorded audio was transcribed.
- Mock generation receives the same typed context request that a future backend receives and returns fragmented NDJSON through an async iterator.
- Default canvas: light background; grid off; select tool; 100% zoom; follow live enabled.
- Supported shapes: rectangle, rounded rectangle, circle, ellipse, diamond, standalone text. Connections: directed arrow or plain line between nodes. No freehand, arbitrary SVG, images, mathematical typesetting, collaboration, or user accounts in v1.
- Desktop-first, with mouse, trackpad, and basic two-finger touch navigation. Browser resize must preserve the scene.
- No emoji in the UI. Use consistent labelled icons and tooltips.

## Non-negotiable architecture rules

1. One canonical scene store. Neither Konva objects nor UI components are the authoritative document.
2. All manual and generated edits go through the same validated command dispatcher.
3. Keep transport, parsing, scene logic, layout, rendering, and viewport independently testable.
4. World coordinates are independent of screen size and zoom. Node coordinates are local to their section.
5. LLM output stays compact. The client computes typography, shape geometry, colours, arrow paths, and section placement.
6. Do not rearrange established objects on every streamed event. New geometry must preserve the audience's mental map.
7. Never send a generation request without a fresh context snapshot and revision.
8. Manual edits win over stale generated changes. Reject conflicts explicitly rather than silently overwriting.
9. No artificial delay between receipt of a valid operation and rendering. Batch within a frame, not across a completed response.
10. Tool and viewport changes do not increment document revision.

## Agent ownership and execution order

| Agent | Ownership | Depends on | Exclusive paths |
|---|---|---|---|
| 0 | Foundation, integration and release | None initially; integrates all | package files, root config, src/app, README, CI |
| 1 | Contracts, validation, canonical scene and history | Agent 0 scaffold | src/contracts, src/scene |
| 2 | Layout, shape sizing and connector geometry | Agent 1 contracts | src/layout |
| 3 | Konva renderer and viewport navigation | Agents 1–2 interfaces | src/board |
| 4 | Manual tools and editing interactions | Agents 1–3 interfaces | src/editor |
| 5 | Stream parser and generation transport | Agent 1 contracts | src/stream |
| 6 | Session, speech adapters and context requests | Agents 1, 2, 5 interfaces | src/session, src/context, src/audio |
| 7 | Minimal UI and accessibility | Shared contracts; agents' public APIs | src/ui, src/styles |
| 8 | Cross-component QA, fixtures and benchmarks | All contracts; integrated app | tests/e2e, tests/fixtures, tests/performance |

Each agent owns unit tests next to its code. Agent 8 owns cross-component tests. Only Agent 0 changes dependencies, lockfiles, app composition or CI. Request changes to another agent's interface through Agent 0; do not fork the shared types.

Execution waves:

1. Agent 0 scaffolds the app. Agent 1 publishes contracts, schemas, sample operations and interface stubs. Agent 0 freezes protocol v1.
2. Agents 2, 5, 6, 7 and 8 work against contracts/stubs. Agent 3 starts against geometry fixtures. Agent 4 starts against the dispatcher interface.
3. Agent 0 integrates a vertical slice: fixture transcript → context request → mock stream → node on canvas.
4. Integrate manual edits, sections, recording preview, navigation and conflicts.
5. Run the shared acceptance suite; fix failures within ownership; release a clone-and-run repository.

## Shared contract: document and coordinates

Agent 1 must implement the following concepts in TypeScript and runtime schemas. This document is the source of truth for semantics; executable schemas become the source of truth for field validation.

```ts
type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };
type Shape = 'rect' | 'roundRect' | 'circle' | 'ellipse' | 'diamond' | 'text';
type Color = 'neutral' | 'blue' | 'green' | 'orange' | 'red' | 'purple';
type Source = 'manual' | 'generated';

interface Node extends Box {
  id: string; sectionId: string; type: Shape; label: string; color: Color;
  source: Source; locked: boolean; revision: number; lastManualRevision: number;
  sizing: 'auto' | 'fixed';
}
interface Edge {
  id: string; sectionId: string; from: string; to: string;
  kind: 'arrow' | 'line'; label: string; color: Color;
  source: Source; locked: boolean; revision: number; lastManualRevision: number;
}
interface Section {
  id: string; title: string; order: number; origin: Point; bounds: Box;
}
interface Scene {
  schemaVersion: 1; documentId: string; revision: number;
  sections: Record<string, Section>;
  nodes: Record<string, Node>; edges: Record<string, Edge>;
}
interface Viewport { x: number; y: number; scale: number }
```

Entity IDs are globally unique within a document, including sections. Generated IDs receive a request prefix before model input/output processing, such as `g_r12_server`; manual IDs use `m_` plus a UUID. Existing IDs in context are already canonical and must not be prefixed again. Never reuse deleted IDs during a session. Maintain tombstones for conflict/replay handling.

Node `(x,y)` is its top-left bounding-box position in section-local world units. Circle width equals height. Section `origin` is a world-space translation; `bounds` is section-local and includes content plus title/padding. Screen conversion: `screen = world * scale + viewport translation`. Inverse: `world = (screen - translation) / scale`. Section-local coordinates subtract section origin from world coordinates.

UI state is separate: selected IDs, active tool, grid visibility, snap enabled, active section, viewport, follow mode, transient drag/resize state, session state. A selected section and the currently generated section may differ while browsing history.

## Shared contract: compact streamed operations

One operation per JSON line. String newlines must be escaped. No markdown fences, prose, nested document dumps, or Konva properties.

```jsonl
{"op":"section.add","id":"g_r1_topic","title":"Request flow"}
{"op":"node.add","id":"g_r1_browser","section":"g_r1_topic","type":"rect","label":"Browser","at":[0,0],"color":"blue"}
{"op":"node.add","id":"g_r1_server","section":"g_r1_topic","type":"roundRect","label":"Server","place":{"rightOf":"g_r1_browser"}}
{"op":"edge.add","id":"g_r1_e1","section":"g_r1_topic","from":"g_r1_browser","to":"g_r1_server","label":"Request"}
{"op":"node.update","id":"g_r1_server","set":{"label":"API server"}}
{"op":"edge.update","id":"g_r1_e1","set":{"color":"green"}}
{"op":"entity.delete","id":"g_r1_e1"}
```

Allowed operations and semantics:

| Operation | Required | Optional / behaviour |
|---|---|---|
| section.add | id, title | Appends a section; identical replay is a no-op |
| node.add | id, section, type, label | color; at OR place; default colour neutral; renderer sizes node |
| edge.add | id, section, from, to | label; color; kind defaults arrow |
| node.update | id, set | Allowlist: label, color, type, at; generated size is derived |
| edge.update | id, set | Allowlist: label, color; endpoint edits require delete/add in v1 |
| entity.delete | id | Node or edge only; deleting a node removes its incident edges |

`at: [x,y]` uses section-local world units, not grid indices. This is the only meaning of `at` across the project. `place` accepts exactly one of `rightOf`, `below`, `leftOf`, `above`; all reference a node in the same section. Relative placement uses measured bounds plus a shared 64-unit gap. If both position forms are absent, use the next available placement. All position hints for generated additions may receive collision correction. Explicit manual placement is respected, including intentional overlap. Grid visibility is independent of snapping.

No cross-section edges or self-loop edges in v1. Schema errors produce diagnostics; they never crash the board. Updates to label/type recompute auto-sized bounds; fixed-size manual nodes wrap or truncate text with a visible full-text inspector.

## Shared contract: command application and concurrency

```ts
interface CommandMeta {
  source: Source; requestId?: string; baseRevision?: number;
  sequence?: number; sessionEpoch: number; transactionId: string;
}
type ApplyResult =
  | { status: 'applied' | 'duplicate'; revision: number }
  | { status: 'pending'; reason: string }
  | { status: 'rejected'; code: string; message: string };
```

`dispatch(command, meta)` is the only persistent write path. Manual editor commands additionally support size changes, lock/unlock and section rename. Internal derived layout changes are committed atomically with their initiating edit and do not count as manual edits. Increment scene revision once per committed transaction; increment affected entity revisions. Keep UI previews out of the document until a drag/resize commits.

Generated operations carry `baseRevision` captured at request time. Reject a generated update/delete if its target has `lastManualRevision > baseRevision`, is locked, is a manually created entity, or is currently being edited. Manual entities may be referenced as connection endpoints and placement anchors. Model updates to earlier generated entities are allowed when conflict-free. Use a single generation request in flight in v1; this avoids competing generated revisions.

Re-evaluate collision placement against the latest scene when applying an addition. Never trust context positions as the current store. Reject operations from obsolete session epochs after reset/cancel. Deduplicate by `(requestId, sequence)` and retain applied sequence state until session disposal. An identical repeated add is a no-op; conflicting duplicate IDs are rejected. Missing dependencies are held until available with a bound of 200 pending operations; unresolved operations are reported at request end. Deleted targets are rejected immediately, not held forever.

Manual undo/redo uses inverse field-level patches with expected revisions. Undo must not restore a whole old scene and erase newer generated content. Group a drag as one transaction. Deleting a node captures its incident edges for undo. If a later edit changed a field required by undo, show a conflict and skip that transaction. Generated changes are excluded from manual undo history in v1. New manual edits clear redo. Bound history to 100 transactions.

## Shared contract: context sent on every generation request

```ts
interface GenerationRequest {
  protocolVersion: 1;
  requestId: string; sessionId: string; sessionEpoch: number;
  baseRevision: number; idPrefix: string;
  transcript: { segmentIds: string[]; text: string; startMs: number; endMs: number };
  board: {
    activeSectionId: string | null;
    sections: Array<{ id: string; title: string; origin: Point; bounds: Box }>;
    nodes: Array<Pick<Node, 'id' | 'sectionId' | 'type' | 'label' | 'color' |
      'x' | 'y' | 'width' | 'height' | 'locked' | 'source' | 'revision'>>;
    edges: Array<Pick<Edge, 'id' | 'sectionId' | 'from' | 'to' | 'kind' | 'label' | 'color'>>;
    viewport: Viewport; visibleWorldBounds: Box;
    selectedIds: string[];
    contextComplete: boolean; omittedEntityCount: number;
  };
}
interface GenerationTransport {
  generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<Uint8Array>;
}
```

Context contains actual resolved geometry after layout and committed manual movement. It excludes Konva instances, event handlers, history, microphone blobs and transient editor state. Build it immediately before sending, not when a transcript segment is first queued. Clone/freeze the request so later edits cannot mutate an in-flight snapshot. Include defaulted values because the model needs to understand the current board.

V1 sends the full document within a configurable 256 KiB UTF-8 context budget. Never silently truncate. If exceeded, pause generation with a clear limit message; manual editing still works. A later explicitly versioned compact mode may send the full active section plus older section summaries and relevant references. Do not implement hidden summarization in v1. In v1 `contextComplete` is always true and `omittedEntityCount` is zero for sent requests.

Capture the scene and its revision atomically. If drag/resize or label editing is active, defer request creation until commit/cancel, ensuring requests describe displayed committed positions. Transcript collection continues meanwhile.

## Agent 0 — Foundation, integration and release owner

### Subcomponents and goals

- **Repository scaffold:** Vite React TS app, strict compiler settings, format/lint scripts, test commands, lockfile and supported runtime declaration. Resolve mutually compatible package versions at implementation time; do not guess pinned versions from this plan.
- **App composition:** create store/controller once, inject transport and speech adapters, connect public APIs, provide cleanup and error boundary.
- **Integration harness:** deterministic demo starts from the same empty scene; no microphone permission or external services required.
- **Contributor experience:** README, architecture map, protocol examples, contribution guide, explicit project license chosen by repository owner, CI.

### Checklist

- [ ] Publish shared interface stubs before parallel implementation.
- [ ] Own dependency and shared-contract change approvals; document decisions.
- [ ] Wire all controllers through dependency injection; no duplicated singleton stores.
- [ ] Ensure React development remounts do not duplicate listeners or requests.
- [ ] Provide `npm ci`, `npm run dev`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`.
- [ ] Keep real backend optional; document future request/stream boundary.
- [ ] Run integrated checks and collect each agent's handoff.
- [ ] Do not publish to GitHub until repository destination and publishing action are authorized.

## Agent 1 — Protocol, scene store, validation and history owner

### Subcomponents and goals

- **Schemas:** operation discriminated union, scene schema, request schema, internal manual commands and error codes.
- **Dispatcher/reducer:** deterministic validated mutation, entity lookup, revisions, source protection, tombstones, pending dependencies and transactions.
- **History:** manual undo/redo with field-level inverses and conflict checks.
- **Persistence:** versioned JSON export/import and debounced IndexedDB scene autosave; persist document, not raw audio or transient interactions. Restore only after explicit schema validation.
- **Selectors:** entity/section selectors that preserve unchanged references and minimize rerenders.

Public exports: `createSceneStore`, `dispatch`, `getSnapshot`, `subscribe`, `undo`, `redo`, `importScene`, `exportScene`, operation/request schemas. Geometry is injected through a documented layout interface; store does not import React or Konva.

### Checklist

- [ ] Reject non-finite numbers, unsupported enum values, duplicate conflicts and prototype-related keys.
- [ ] Limits: 64-character IDs, 500-character node labels, 120-character section titles, 200-character edge labels; configurable maximum 5,000 entities and 100 sections.
- [ ] Coordinate range ±100,000; node dimensions 24–2,000 world units.
- [ ] Apply defaults centrally; empty text labels are allowed only for manual placeholders.
- [ ] All accepted changes remain exportable and replayable.
- [ ] Delete cascades edges; pending edges cannot resurrect tombstoned nodes.
- [ ] Manual/generated conflict rules and stale epochs are covered by tests.
- [ ] Import failure preserves the existing document; successful import cancels active generation and resets history.
- [ ] Autosave quota/failure is visible without blocking drawing.

## Agent 2 — Incremental layout and connector geometry owner

### Subcomponents and goals

- **Text measurement:** shared font metrics, padding, wrapping and size defaults. Use a bundled/system font consistently; remeasure after chosen font becomes ready.
- **Placement:** absolute hints, four relative hints, deterministic free-slot search and bounded collision resolution.
- **Sections:** append below previous bounds with 160-unit spacing; calculate local bounds and world origins.
- **Connections:** straight line with shape-boundary attachment, arrowhead sizing and midpoint labels. Diamonds and ellipses need real boundary intersection calculations.

Public exports: `measureNode`, `resolvePlacement`, `layoutTransaction`, `getSectionBounds`, `routeEdge`, `screenToWorld`, `worldToScreen`, `worldToSection`. Coordinate transforms are pure and shared with renderer/editor.

### Checklist

- [ ] Existing nodes stay stable when a generated node is added.
- [ ] Search bounded candidate slots; if no fit, append in free space and emit diagnostic.
- [ ] Manual positions are respected, including overlap; generated nodes avoid committed manual bounds.
- [ ] Relative anchors missing at first are pending; cyclic relative dependencies terminate with diagnostics.
- [ ] Section growth can shift downstream origins; viewport receives an anchor compensation delta.
- [ ] Edges update when endpoints move, resize, relabel or change type.
- [ ] Labels remain readable; edge labels have a background for contrast.
- [ ] Zero-distance endpoints, empty labels and very long words do not create NaN geometry.
- [ ] Text resizing does not move unrelated established nodes; flag overlap if growth causes it.
- [ ] Document that v1 straight edges may cross shapes; obstacle routing is a later feature.

## Agent 3 — Konva board, viewport and rendering owner

### Subcomponents and goals

- **BoardStage:** responsive stage with explicit dimensions and device-pixel-ratio handling.
- **Layers:** non-interactive grid/background; scene shapes/edges; interaction overlay. Do not allocate one canvas layer per object or section.
- **NodeView / EdgeView / SectionView:** render canonical geometry and colour tokens; unchanged objects preserve component identity.
- **ViewportController:** pointer-anchored zoom, panning, scroll, fit section, fit board, reset zoom, follow live and manual navigation.
- **Visibility:** cull offscreen sections and geometry with overscan; edges remain visible when their paths intersect the viewport even if endpoints are offscreen.

Public API: `Whiteboard`, `ViewportController` with `panBy`, `zoomAt`, `fitSection`, `fitBoard`, `resumeLive`, `screenToWorld`, `getViewport`. Expose interaction callbacks and node refs needed by Agent 4 without exposing a second scene state.

Navigation specification:

| Input | Behaviour |
|---|---|
| Wheel / two-finger trackpad scroll | Pan using both delta axes; normalize deltaMode |
| Ctrl/Cmd + wheel or trackpad pinch | Zoom about pointer; prevent page zoom only over canvas |
| Space + primary drag | Temporary pan tool |
| Middle-button drag / hand tool drag | Pan |
| Touch pinch | Zoom around gesture midpoint |
| Two-finger touch drag | Pan |
| Toolbar + / − | Zoom about viewport centre |
| Fit section | Fit active section with padding and readable zoom limits |

Zoom range: 0.15–4.0. At minimum, never let scale become zero or negative. Scroll gestures over the sidebar scroll the sidebar, not the canvas. Prevent Space from scrolling the page only while the canvas has focus and no text field is active.

### Checklist

- [ ] Grid toggle redraws the background without mutating scene or request revision.
- [ ] Grid spacing adapts at low zoom; avoid drawing millions of lines.
- [ ] Manual pan/zoom suspends follow; explicit Resume live restores it.
- [ ] New section focuses once; streaming additions only pan if outside a safe viewport margin.
- [ ] Follow tracks latest generated section independently of browsing selection.
- [ ] Camera animations can be interrupted; reduced-motion setting disables them.
- [ ] No refit on every event and no queued animation backlog.
- [ ] Section reflow compensation preserves the user's visual anchor.
- [ ] Canvas resize and high-DPI displays preserve accurate hit testing.
- [ ] Clean up observers, pointer capture and listeners on unmount.

## Agent 4 — Manual component palette and editing owner

### Subcomponents and goals

- **Tool controller:** select, hand, each shape, text, arrow and line.
- **Insertion:** sidebar click arms a tool; canvas click inserts in the chosen section using inverse viewport transform. Also support dragging a palette item onto the board. Clicking a shape while a tool is armed must have predictable behaviour documented in tool hints.
- **Selection/editing:** single selection, Shift multi-select, drag, resize, delete, duplicate, label editing, colour and lock toggle.
- **Connector tool:** click source then destination; preview follows pointer; Escape cancels; endpoints reference IDs.
- **Text overlay:** positioned DOM input/textarea matching canvas transforms, commit Enter for single-line labels or Ctrl/Cmd+Enter for multiline text; Escape cancels. Preserve IME composition.

Inserting on an empty board creates a manual section first. Else use the section under the pointer, falling back to the selected section; never silently switch to the generated section. Dragging an object stays within its current section in v1; section reassignment is deferred. User placement may extend section bounds. Minimum resize limits apply; circle keeps equal dimensions. Rotation is out of scope.

### Checklist

- [ ] Each shape can be inserted from sidebar and edited after insertion.
- [ ] Insertions and movement work correctly at any pan/zoom.
- [ ] Convert Konva transient scale back into canonical width/height on resize commit; reset scale to one.
- [ ] Drag/resize previews render smoothly; commit one document transaction at gesture end.
- [ ] Incident arrows visually follow previews and use committed geometry at completion.
- [ ] Disable generated edits to actively edited entities.
- [ ] Locked entities remain selectable but cannot be moved/resized/deleted until unlocked.
- [ ] Duplicate remaps IDs and duplicates internal edges only when both endpoints are selected.
- [ ] Delete and undo respect revision guards and incident-edge rules.
- [ ] Shortcuts never intercept typing in inputs or textareas.
- [ ] UI state exposes interaction-in-progress for context snapshot deferral.

## Agent 5 — Streaming parser and generation transport owner

### Subcomponents and goals

- **Decoder:** incremental UTF-8 decoder with streaming mode; line buffer supports LF/CRLF, arbitrary byte splits, and a final valid line without newline.
- **Validator bridge:** parse each complete line, validate with shared schema, attach request metadata, enqueue dispatcher work.
- **Frame scheduler:** apply all ready operations within an 8 ms per-frame processing budget and schedule remaining work next frame. Never drop structural operations.
- **Mock transport:** async byte stream with seeded fragmentation, delays, bursts, malformed records, disconnects and cancellation.
- **Transport lifecycle:** request start/end/error diagnostics, abort propagation and sequence metadata outside model-generated JSON.

Public exports: `createStreamConsumer`, `MockGenerationTransport`, `GenerationTransport`. Parser owns framing; Agent 1 owns semantic pending dependencies. Mock transport is deterministic and supports a provided operation fixture. For the standard demo, it uses incoming transcript segment IDs to choose fixture operations and incoming board context to reference existing objects instead of duplicating them.

### Checklist

- [ ] UTF-8 multibyte labels survive splits in the middle of a character.
- [ ] A malformed completed line is reported and later valid lines still render.
- [ ] Maximum line size 64 KiB and buffered partial record 128 KiB; overflow aborts request clearly.
- [ ] Blank lines are ignored; unsupported markdown fences are diagnosed.
- [ ] Cancelled request chunks cannot mutate scene afterward.
- [ ] Queue bounded to 2,000 operations; overflow pauses/aborts with visible status, never silently loses objects.
- [ ] No waiting for stream completion before first render.
- [ ] Sequence and request IDs support replay deduplication; retries do not assign new IDs to already accepted operations.
- [ ] Partial disconnect keeps valid applied work and reports incomplete status; no automatic full replay in v1.
- [ ] Mock and future HTTP transport expose the same interface; an HTTP adapter may later consume a POST response stream.

## Agent 6 — Session, microphone preview and whiteboard context owner

### Subcomponents and goals

- **Session coordinator:** owns session ID/epoch, transcript queue, in-flight request and status transitions.
- **Mock speech source:** emits interim/final transcript fixtures with timestamps, correction examples and explicit topic transitions.
- **Microphone preview source:** explicit user Start action, permission handling, MediaRecorder capability detection and visible recording state. Record locally; keep a bounded preview buffer. No network audio upload in v1.
- **Context builder:** serialize fresh current scene, resolved placement, visible bounds, selected IDs and active generation section for every request.
- **Request scheduler:** final transcript segments only; coalesce queued segments while a request is active; never drop speech silently.
- **Future audio adapter contract:** define capture → backend transcription → final segments → generation request; keep raw audio out of the drawing protocol.

Public exports: `createSessionController`, `buildGenerationRequest`, `MockSpeechSource`, `MicrophonePreviewSource`. Speech event contract: `{id, text, startMs, endMs, isFinal}`. Finalized segment IDs are unique and sent once; interim revisions do not create drawing requests. State axes: capture (`idle/requesting/recording/paused/error`) and generation (`idle/queued/streaming/paused/error`), rather than a single ambiguous status.

Schedule default: group finalized text for up to 400 ms when idle, then send; if a request is active, accumulate subsequent final segments and send immediately after completion using a fresh context. Flush explicit Send now immediately. Only one request in flight. Maximum queued transcript: 10,000 characters or 30 seconds; at limit pause intake with a visible message rather than discard. Track queue age separately from model latency.

Pause stops new input and lets an existing request finish. Stop cancels input and generation, retains valid scene changes and unsent transcript for explicit retry. Reset increments epoch, cancels work, clears document only through a confirmed reset action, and prevents late results from appearing. Failed request segments remain associated with their partial result; Retry uses stable request/operation identity.

### Checklist

- [ ] Default demo works without microphone permission.
- [ ] Recording preview is distinctly labelled “Local recording — transcription mocked”.
- [ ] Denied permission, no device, unsupported MediaRecorder and device removal have actionable states.
- [ ] Stop/unmount stops every media track and revokes preview object URLs.
- [ ] Audio preview buffer is capped at 60 seconds; older chunks are discarded visibly; no raw audio persistence by default.
- [ ] Do not assume MediaRecorder chunks are independently decodable audio files.
- [ ] Current context includes manually added nodes, manually moved coordinates and current dimensions.
- [ ] Requests do not contain stale drag preview geometry or mutable store references.
- [ ] Context size overflow pauses generation and preserves transcript queue.
- [ ] Request inspector shows transcript, base revision, context size and sent JSON for development.
- [ ] Topic change comes from explicit mock/model section operations, not a timer or keyword guess in renderer.
- [ ] Document future HTTPS/localhost microphone requirement and server-side API key storage.

## Agent 7 — Minimal application UI and accessibility owner

### Subcomponents and goals

- **App shell:** compact top bar; narrow left tool palette; canvas takes remaining space; collapsible section/transcript panel; optional inspector.
- **Top bar:** session name, mock/live-preview mode label, Start/Pause/Stop, generation status. Keep developer diagnostics collapsed.
- **Palette:** select, hand, supported shapes, text, connectors, colour swatches, grid toggle and independent snap toggle.
- **Viewport controls:** zoom percentage, +/−, fit section and Resume live.
- **Properties panel:** selected shape label, colour, size and lock; appears only when useful.
- **Session panel:** interim/final transcript distinction, topic list, pending status and friendly recovery messages.
- **Keyboard/accessibility layer:** meaningful focus order, visible focus ring, tooltips, aria-labels and a DOM scene outline for canvas content.

Visual guidance: neutral background, subtle borders, one accent colour, 8-unit spacing scale, consistent icon stroke and sizes, readable labels. No emoji, decorative gradients, oversized cards or marketing content. Recording status uses both text and a visual indicator. Icons require accessible names; icon-only controls get tooltips. Error diagnostics belong in a collapsible panel, not repeated toast storms.

### Checklist

- [ ] Main board is usable at 1280×720 and 1920×1080; panels collapse on smaller windows.
- [ ] Toolbar buttons have clear active/disabled states and at least 36×36 px hit areas.
- [ ] All features have keyboard-accessible controls; canvas has an accessible alternative outline.
- [ ] Grid toggle, snap toggle and follow toggle are independent.
- [ ] No browser page scrolling during focused canvas gestures; side panels remain scrollable.
- [ ] Clean empty state offers Start demo or add a shape.
- [ ] Status accurately distinguishes recording, mock transcript, request queued and stream receiving.
- [ ] Theme tokens are shared by canvas labels and DOM controls.
- [ ] Contrast and reduced-motion behaviour are tested.
- [ ] Wire only public callbacks; UI never directly mutates scene records.

## Agent 8 — Integration QA, performance and fixture owner

### Subcomponents and goals

- **Protocol fixtures:** all shapes, branching flow, topic change, relative placement, correction, duplicate replay and dependency disorder.
- **Browser journeys:** manual edits while streaming; pan/zoom; grid; topic following; microphone permission errors; export/import.
- **Failure injection:** malformed JSON, split Unicode, late chunks after reset, missing references, context limits and stalled transport.
- **Performance harness:** generated streams at controlled rates; timing markers and scene counts; long-session navigation.

Required end-to-end acceptance scenarios:

1. Start demo: Browser appears, Server appears, Request arrow appears before stream ends.
2. Pause demo input; add a manual Database, move/resize it; resume; next request includes exact committed bounds and a subsequent edge can reference it.
3. Begin a request, manually edit an existing generated label, receive a stale update; manual label survives and conflict is recorded.
4. Receive a new section; camera follows once; pan away; further updates do not steal viewport; Resume live returns.
5. Add a shape at 50% and 200% zoom after panning; it appears under the pointer.
6. Toggle grid repeatedly; shape positions and scene revision remain unchanged.
7. Deliver an edge before its endpoint and split JSON/Unicode across chunks; diagram resolves correctly.
8. Reset during streaming; late events cannot repopulate the cleared board.
9. Deny microphone permission; mock mode and manual editing still work.
10. Delete a node with edges, undo, then receive newer generated work; undo does not erase unrelated work.
11. Export/import the document and compare canonical geometry, IDs, labels and sections.
12. Grow an earlier section; downstream sections do not overlap and viewport anchor remains stable.

### Performance targets and measurement

Targets are acceptance goals, not claimed measurements. Record browser, machine, device pixel ratio and dataset with results.

- 500 visible entities: p95 complete-operation-to-draw under 50 ms at 30 operations/second.
- 5,000 total entities across 50 sections: navigation remains responsive with offscreen culling.
- Input gestures should generally sustain 50+ FPS on the documented reference machine.
- No unbounded buffers, listener leaks or continued media capture after Stop.
- Distinguish decode time, validation/layout time, commit time, canvas draw time and transcript queue delay.
- Instrument Konva draw completion; requestAnimationFrame alone does not prove a pixel reached the display. Use browser traces for approximate paint validation.
- Benchmark collision/layout work and edge recalculation separately; only recompute affected geometry.

### Checklist

- [ ] All twelve journeys pass in Chromium; smoke navigation and recording fallback in Firefox/WebKit where available.
- [ ] Unit tests cover reducer, parser, geometry, context snapshots and undo conflict boundaries.
- [ ] CI executes typecheck, lint, unit tests, build and browser smoke tests.
- [ ] Demo fixture data contains no credentials or external network dependency.
- [ ] Benchmark results and known limitations are documented honestly.
- [ ] Check that mock mode does not call real LLM/STT endpoints.

## Reference directory structure

```text
src/
  app/                 # Agent 0: composition, providers, lifecycle
  contracts/           # Agent 1: operations, requests, scene schemas
  scene/               # Agent 1: reducer, store, history, persistence
  layout/              # Agent 2: measure, placement, sections, connectors
  board/               # Agent 3: stage, views, layers, viewport
  editor/              # Agent 4: tools, gestures, text overlay, selection
  stream/              # Agent 5: decoder, scheduler, transport, mocks
  session/             # Agent 6: coordinator and transcript scheduling
  context/             # Agent 6: request builder and budget validation
  audio/               # Agent 6: speech fixtures and recording preview
  ui/                  # Agent 7: panels, toolbars, outline, controls
  styles/              # Agent 7: theme tokens and layout styles
tests/
  fixtures/            # Agent 8: cross-component scenario data
  e2e/                 # Agent 8: browser acceptance journeys
  performance/         # Agent 8: workloads and measurement scripts
docs/
  protocol.md          # Agent 1 content, Agent 0 integration
  architecture.md      # Agent 0
  agent-handoffs/       # one handoff per agent
```

## Integration milestones and release gates

### Gate A — Contract baseline

- [ ] Shared schemas and coordinate units finalized.
- [ ] One valid example for every operation; invalid examples and error codes supplied.
- [ ] Public interfaces compile with stubs and agents agree ownership boundaries.

### Gate B — First live visual

- [ ] Mock transcript creates a request with full empty-board context.
- [ ] Stream is fragmented and the first shape renders before the response finishes.
- [ ] Following requests include all previous resolved geometry.

### Gate C — Presenter control

- [ ] Manual palette, label editing, connections, resize, delete and history integrated.
- [ ] Pan, scroll, zoom, grid, snapping and follow mode work together.
- [ ] Every generation request includes latest committed manual placement.

### Gate D — Robust session

- [ ] Topic sections, context limits, stale results, partial streams and conflicts handled.
- [ ] Permission failure and audio cleanup tested.
- [ ] Export/import and autosave recovery validated.

### Gate E — Open-source-ready handoff

- [ ] Fresh clone works with documented commands and no credentials.
- [ ] Tests/build pass; measured performance and limitations published in docs.
- [ ] License decision resolved with repository owner before public release.
- [ ] Demo clearly identifies mock speech/generation and local microphone preview.
- [ ] All agents provide handoff notes; Agent 0 completes final integration review.

## Required agent handoff template

Each agent delivers `docs/agent-handoffs/agent-N.md` with:

1. Owned components and completed checklist items.
2. Exact public exports and a small usage example.
3. Files changed and any shared-contract decisions.
4. Tests run, commands and actual outcomes.
5. Integration dependencies and how to reproduce the demo path.
6. Known limitations, unresolved errors and performance observations.

An agent must not mark its work complete merely because its isolated demo renders. Its public interface must compile against shared contracts and pass the relevant integrated journey.

## Future backend boundary — design now, implement later

Python/FastAPI can later expose a transcription channel for audio and a POST generation endpoint accepting `GenerationRequest` and returning a streamed NDJSON response. Keep credentials server-side. Include request ID, cancellation and session epoch in transport handling. The backend should validate input, supply protocol instructions to the LLM, and validate/forward bounded operations. Browser rendering begins as each operation arrives.

Do not couple drawing to a provider SDK or a browser-only speech service. The mock adapters must be replaceable without changes to scene, layout, editor or board components. Raw audio transport, actual speech recognition quality, LLM latency and topic detection accuracy are explicitly outside v1 acceptance; their future latency must be measured separately from rendering.
