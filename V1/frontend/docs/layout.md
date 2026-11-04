# Layout and geometry: Agent 2

The production adapter is `createLayoutEngine` from `src/layout/index.ts`. It satisfies the existing SceneLayout contract without changes to shared schemas or the scene store. The pure `layoutTransaction(input, options)` function computes the same geometry without keeping a cache or UI anchor state.

## Browser composition

```ts
import { createSceneStore } from '../src/scene';
import { createLayoutEngine, prepareLayoutFonts } from '../src/layout';

await prepareLayoutFonts();
const layout = createLayoutEngine();
const store = createSceneStore({
  documentId: 'whiteboard',
  layout,
  onLayout: ({ anchorDelta }) => {
    if (!anchorDelta) return;
    // Agent 3: preserve the anchored section's screen position.
    // viewport.x -= anchorDelta.x * viewport.scale;
    // viewport.y -= anchorDelta.y * viewport.scale;
  },
});
layout.setAnchorSection('g_r1_topic'); // use the section being viewed; null disables compensation
```

Prepare fonts before the store's first layout. Recompute any preliminary measurements after preparation resolves. The chosen system font is Arial with a sans-serif fallback, with shared sizes and weights for nodes, section titles and connectors. No webfont download is required. `prepareLayoutFonts` loads the chosen normal/title/edge variants and waits for document.fonts.ready. `createCanvasTextMeasurer` supplies real Canvas2D widths. Headless callers inject a TextMeasurer; the default deterministic estimate is explicitly flagged in measurements and diagnostics and is not claimed to match browser glyph widths. Fonts/metrics must remain fixed for a composed document; a future live font/theme switch needs a scene-level remeasurement command through Agent 0.

## Typography and shapes

`measureNode({type,label}, {measurer?})` returns width, height, estimated and text layout. `layoutNodeText({type,label,width,height})` handles canonical fixed geometry and truncation. Node size limits remain 24–2,000; circles keep equal dimensions. Rectangles/rounded rectangles use padded text regions. Diamonds and ellipses/circles use conservative inscribed regions. Standalone text has smaller padding.

Word wrapping preserves explicit newlines, splits long words at grapheme boundaries and handles manual empty placeholders. Full text remains available in `text.fullText`; clipping sets truncated and adds an ellipsis when room permits. Auto-size saturation emits diagnostics. Fixed nodes wrap/truncate without changing geometry; Agent 7 must show full labels in the inspector.

For Konva text, use the supplied lines joined with newline, fontFamily, fontSize, fontWeight and lineHeight/fontSize ratio. Use the text region x/y/availableWidth/availableHeight and centered alignment. Do not independently re-wrap or remeasure labels with different settings. Section headers come from getSectionHeader; edge text uses the RoutedEdge label's box/padding/text. Rounded rectangle corner radius is min(ROUND_RECT_RADIUS, width/2, height/2).

## Placement and section stability

`resolvePlacement({node,nodes,source,at?,place?,maxCandidates?})` returns x/y, attempt count, corrected/exhausted flags and diagnostics. at remains section-local world units. Four relative hints use actual measured anchor dimensions and a 64-unit gap. Eligible generated nodes can move within affected sections to repair collisions; manual and locked geometry stays fixed.

Generated additions search deterministic square shells around the requested/default point, respecting committed manual and generated bounds with 16 units of clearance. Default search budget is 256 candidates; configuration permits 1–4,096. Exhaustion tries at most four append positions outside the occupied union and emits a diagnostic on success. If those positions exceed coordinate limits, the operation fails atomically; it does not keep searching indefinitely or silently overlap. Manual explicit placement, including intentional overlap, is respected. No-position manual insertions still search for a free slot. Layout does not use grid/snap UI state.

The adapter measures all required nodes before resolving additions in dependency order. It respects a later explicit move in the same transaction and excludes unplaced provisional nodes from collision obstacles. Existing label/type growth remeasures before collision repair. Generated updates prefer moving the changed node, with position-only neighbor repair allowed in the affected section. Manual edits preserve their explicit positions. Missing/cyclic anchors are owned by the store's bounded dependency queue, not a layout recursion.

`getSectionBounds` includes node geometry, optional contentBounds, header and padding. The engine also includes connector-label backgrounds. Negative local content is supported. `layoutSections` places a new section exactly 160 world units below the preceding section's bounds; existing sections move down only when needed, and do not move up on shrink. Local node coordinates remain unchanged. History preserves restored positions while recomputing text/section geometry.

`setAnchorSection(id|null)` is transient engine/controller configuration, not a scene write. It selects which section's origin delta is returned as anchorDelta. Agent 3 subtracts delta × scale from viewport translation. `getSectionOriginDeltas(previousScene,nextSections)` is available when the controller needs all changes. No default anchor is guessed from the generated section.

Coordinate and box limits still come from Agent 1. A node at the extreme negative coordinate limit can require header/padding outside the representable box range; too many very tall sections can similarly exceed origin limits. Such edits reject with LAYOUT and preserve the current scene. The adapter never clamps an explicit manual position or silently drops padding to force a commit.

## Connectors and transforms

`routeEdge(edge,scene,{measurer?})` returns world-space start/end/points, arrowhead geometry, optional midpoint label background and diagnostics, or null for missing/invalid topology. Attachments solve rectangle/text, rounded-corner, ellipse/circle and diamond boundaries. Arrowheads shorten on tiny segments. Touching endpoints and coincident centers produce finite geometry; coincident centers use deterministic horizontal attachments and a diagnostic.

Labels use a white background for contrast, with a maximum of three visible lines and fullText for the inspector. Wide labels on short connectors are offset perpendicular to the midpoint so their backgrounds do not erase arrowheads. Default light-canvas styling remains provisional until Agent 7 shares theme tokens. Connectors use padded obstacle routing, separate corridor preferences, collision-aware label placement and a bounded visibility-grid fallback. A deterministic section plan reserves earlier routes and labels in sorted edge-ID order. Crossings and shared segments are penalized and reported; they cannot always be eliminated. A failed generated route triggers one wider-spacing recovery pass, then rejects the scene transaction if still impossible.

`createEdgeRouter` caches by edge ID and geometry/content signature, reusing routes across immutable snapshots and ignoring color/revision-only changes. The cache uses bounded LRU retention (default 5,000 entries); invalidate clears it. Any section node movement/resize/type, edge topology/label/kind, or section origin change invalidates the section routing plan. The layout engine maintains its own router for content bounds; the renderer owns a separate cache for drawing.

Pure screenToWorld/worldToScreen use screen = world × scale + viewport translation. worldToSection/sectionToWorld subtract/add section origin. getWorldBounds translates a local bounding box. Transforms reject non-finite points and nonpositive scales. Zoom clamping and navigation gestures belong to Agent 3.

## Agent 3 integration

Read canonical node x/y as section-local TOP LEFT coordinates. Render section origin once as a group translation or convert to world space consistently. Edge routes are already world-space: avoid translating them a second time. Use canonical geometry for committed nodes and transient copies for drag/resize preview routes. Never write Konva transient scales into the scene until a validated editor transaction commits.

Agent 3 now supplies Whiteboard/ViewportController, culling, navigation, follow mode and drawing tests. See [board integration](board.md). The app displays a deterministic renderer fixture; full speech/editor journeys and measured performance targets remain future integration work.
