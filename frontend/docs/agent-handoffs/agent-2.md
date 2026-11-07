# Agent 2 handoff

## 1. Owned components and checklist

Implemented src/layout: shared text metrics/wrapping, shape sizing, bounded incremental placement, section bounds/reflow, boundary-attached straight connectors and coordinate transforms. The SceneLayout adapter runs through the real canonical store, including undo/redo and pending relative dependencies. Existing/manual geometry remains stable; generated collisions resolve against current committed bounds. Text growth reports overlap, bounded-search fallback reports exhaustion, section reflow returns an explicit anchor delta, and edge labels have contrast backgrounds.

All Agent 2 checklist behaviors have implementation/tests. Browser composition waits for the chosen font before first layout and recomputes preliminary metrics after readiness. No React/Konva dependency is imported into layout. Performance targets, renderer gestures and complete integrated product journeys are not claimed.

## 2. Exact public exports and usage

src/layout/index.ts exports:

- Functions: measureNode, layoutNodeText, wrapText, fitText, createCanvasTextMeasurer, getTextMeasurer, prepareLayoutFonts, resolvePlacement, boxesOverlap, getSectionBounds, getSectionTitleLayout, getSectionHeader, layoutSections, getSectionOriginDeltas, routeEdge, getShapeBoundary, createEdgeRouter, screenToWorld, worldToScreen, worldToSection, sectionToWorld, getWorldBounds, layoutTransaction and createLayoutEngine.
- Types: TextMeasurer, TextOptions, TextLayout, NodeMeasurement, PlacementInput, PlacementResult, SectionBoundsOptions, SectionLayoutOptions, RoutedEdge, EdgeRouterOptions and LayoutOptions.
- Metrics/defaults: FONT_FAMILY, FONT_SIZE, LINE_HEIGHT, FONT_CSS, NODE_PADDING, TEXT_PADDING, MAX_TEXT_WIDTH, MIN_NODE_SIZE, MAX_NODE_SIZE, COORDINATE_LIMIT, PLACEMENT_GAP, COLLISION_GAP, MAX_PLACEMENT_CANDIDATES, SECTION_PADDING, SECTION_GAP, SECTION_TITLE_GAP, SECTION_TITLE_SIZE, SECTION_TITLE_LINE_HEIGHT, SECTION_TITLE_MAX_WIDTH, ROUND_RECT_RADIUS, EDGE_LABEL_SIZE, EDGE_LABEL_LINE_HEIGHT and EDGE_LABEL_BACKGROUND; estimatedTextMeasurer is the explicitly flagged headless fallback.

```ts
import { createSceneStore } from '../../src/scene';
import { prepareLayoutFonts, createLayoutEngine, createEdgeRouter } from '../../src/layout';

await prepareLayoutFonts();
const layout = createLayoutEngine();
const store = createSceneStore({ documentId: 'demo', layout });
const router = createEdgeRouter();
layout.setAnchorSection(null); // Agent 3 sets the viewed section, and consumes onLayout anchorDelta
// router.route(edge, store.getSnapshot()) returns committed world-space connector geometry.
```

The engine satisfies SceneLayout and additionally exposes setAnchorSection(id|null). No singleton scene or production fallback from Agent 1's test helpers is introduced.

## 3. Files and shared decisions

- Added src/layout/{index,constants,text,transforms,placement,sections,edges,engine}.ts.
- Added colocated text/placement/transforms/edges/engine tests, test-fixtures.ts, layout.browser.spec.ts and playwright.config.ts. Test fixtures are not exported from the public barrel.
- Added docs/layout.md and this handoff; updated README/architecture/protocol references and shell status.
- Integration-owner changes: added test:layout-browser to package scripts and CI. No dependency, lockfile, scene-store or shared-schema changes were required.
- Arial is the shared system font. Canvas metrics are used in browsers; deterministic estimates are explicitly flagged in headless environments.
- Existing sections never move up after shrink. New sections append exactly, including imported boards with negative origins.
- Viewport anchor choice is transient controller state. Compensation is translation -= anchorDelta × scale; it does not change document revision.
- Edge routes are world-space and cached by dependency signatures with bounded retention. Section bounds include label backgrounds as well as nodes/titles.

## 4. Checks and actual outcomes

Validated on 2 November 2026 on Windows with Node 22.17.1/npm 10.9.2.

| Command                     | Actual outcome                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| npm run check               | Passed: strict types, zero-warning lint, formatting, 106 unit tests across 9 files, production build |
| npm run test:e2e            | Passed: 1 Chromium shell smoke test                                                                  |
| npm run test:scene-browser  | Passed: 1 Chromium IndexedDB regression test                                                         |
| npm run test:layout-browser | Passed: 1 Chromium real-font/layout/connector test                                                   |

Agent 2 added 56 unit tests; all 50 earlier tests still pass. Tests cover all shapes, Unicode/long words, truncation/empty text, actual canvas fonts, all relative hints, bounded fallback, manual overlap, collisions, negative coordinates, stable growth, section reflow/anchor compensation, undo/redo, pending/cyclic dependencies, real shape equations, degenerate endpoints and route cache invalidation/eviction. CI is configured for these commands but has not run remotely.

## 5. Integration dependencies and reproduction

See [layout integration](../layout.md) and [protocol](../protocol.md). Await prepareLayoutFonts before constructing a browser scene; use the engine in createSceneStore. The store continues to own validation/revisions/history. Agent 3 should reuse typography, corner radius, routes and transforms; pass its current viewed section to setAnchorSection and handle onLayout without stealing the user's viewport. Agent 4 will route previews using transient node copies, then commit through the dispatcher.

npm run dev still shows implementation status. npm run test:layout-browser exercises actual Canvas2D metrics and real store geometry without wiring an unfinished renderer into the app. The next implementation stage is Agent 3's Konva board and viewport navigation.

## 6. Known limitations

Straight edges may cross other shapes. Very long labels wrap/truncate with fullText available; the inspector is future UI work. Browser composition must establish font readiness before first layout; live font/theme switching requires coordinated scene remeasurement. System glyph widths vary by platform, while serialization retains actual canonical dimensions.

Scene coordinate/box/origin limits can reject extreme content plus section padding or very tall multi-section layouts. Bounded placement can reject when its finite search and four append positions cannot find representable space. Both failures are atomic and explicit. Existing section shrink leaves intentional free space to preserve the mental map.

Canvas rendering, gestures, follow mode, microphone, streaming and complete whiteboard acceptance journeys remain later work. No FPS/latency targets, cross-browser equivalence or reference-machine benchmarks are claimed. Existing foundation development dependency audit findings were not changed by this implementation.
