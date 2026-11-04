# Konva board and viewport: Agent 3

`src/board/index.ts` exposes Whiteboard, ViewportController, renderer views, interaction types, visibility/grid helpers and theme tokens. The board consumes immutable canonical scenes. Its camera, selection, tool, grid and previews are UI state and cannot dispatch persistent writes.

## Run the renderer preview

Run npm run dev and select **Load renderer fixture**, or add shapes manually using the sidebar. The fixture contains all six shapes, directed arrows and a plain connector, created through the canonical dispatcher and production layout. Manual editing is connected; speech and generation transport remain disconnected. Expand **Renderer fixture controls** for deterministic topic/addition/growth/reset checks. These actions do not simulate microphone input or streamed responses. Fixture/manual data is not autosaved by this app composition.

Default state is an empty scene, select tool, grid off, 100% zoom and follow enabled. The sidebar scrolls independently of the canvas. A DOM scene outline supplies keyboard-accessible text descriptions and focus actions. Agent 4 now supplies editing properties and history controls; import/export UI remains future work.

## Composition and ownership

```tsx
import { Whiteboard, ViewportController } from '../src/board';
import { createLayoutEngine, prepareLayoutFonts } from '../src/layout';
import { createSceneStore } from '../src/scene';

await prepareLayoutFonts();
const layout = createLayoutEngine();
const viewport = new ViewportController({
  onAnchorSectionChange: (id) => layout.setAnchorSection(id),
});
const store = createSceneStore({
  documentId: 'board',
  layout,
  onLayout: ({ anchorDelta }) => {
    if (anchorDelta) viewport.compensateAnchor(anchorDelta);
  },
});
// Subscribe to store.getSnapshot with React useSyncExternalStore, then render:
// <Whiteboard scene={scene} viewport={viewport} grid={grid} tool={tool} />
```

App awaits shared fonts, creates one runtime per mounted lifecycle and disposes it on cleanup. React StrictMode's cancelled font-readiness continuation cannot create a duplicate store/controller. Whiteboard subscribes to the camera, observes the supplied canonical scene and measures its own container using ResizeObserver. The caller owns the store/controller lifetime; Whiteboard cleans its own observers, native listeners, capture state, refs and media-query subscriptions.

Only the scene store is authoritative. The controller retains a read-only scene reference for fit/follow calculations, not a second editable document. Temporary preview copies are rendering inputs only; they never enter revision/history/export/context snapshots.

## ViewportController API

- getViewport(), getSnapshot(), subscribe(listener) expose immutable camera snapshots; subscription returns cleanup.
- panBy({x,y}, options?), zoomAt(screenPoint, absoluteScale, options?), zoomBy(factor, options?), resetZoom(options?). Pan deltas and screen points use CSS pixels.
- fitSection(idOrSection, options?), fitBoard(options?), fitBounds(worldBox, options?) preserve padding and clamp fit zoom to 0.15–1. User zoom is clamped to 0.15–4. Very large content may remain partly outside the viewport at the minimum zoom.
- resumeLive(), suspendFollow(), observeScene(scene, liveSectionId?), compensateAnchor(worldDelta), screenToWorld(screenPoint), getVisibleWorldBounds(overscanPx?).
- setSize({width,height}), setViewport(viewport, options?), setReducedMotion(boolean), dispose().

CameraOptions contains manual and animate. Movement is manual by default and suspends follow. Generated follow/reflow uses manual:false. Fitting before the first nonzero measurement is deferred once; later browser/container resizes preserve camera and scene exactly. No implicit refit occurs on every streamed operation.

New generated sections focus once. Subsequent changes pan only if generated node bounds leave an 80px safe margin (adapted for small viewports), preserving scale. Manual pan/zoom/fit suspends follow. Latest live section metadata keeps advancing while the user browses another section. Resume live returns to it. Corrections to earlier topics do not move focus backwards. Agent 6 can pass an explicit liveSectionId to Whiteboard/observeScene, independently of browsing selection, including null to clear it.

Reflow compensation subtracts world delta × scale from translation without suspending follow. The chosen anchor is held while compensating, avoiding a transient old-scene lookup changing the engine anchor before React observes the new scene. The controller chooses the visible section nearest the viewport center for future reflow callbacks.

Camera animations replace the previous target and retain at most one scheduled frame. Manual input cancels immediately. Reduced motion uses immediate movement; changing that preference also finishes an active animation immediately. Disposal cancels pending frames and subscriptions. Browser pixel paint timing is not inferred from requestAnimationFrame.

## Input behavior

Wheel-up zooms in and wheel-down zooms out around the actual pointer, normalizing pixel/line/page delta modes. Ctrl/Cmd+wheel also zooms. Shift+wheel pans both axes; horizontal-only wheel input pans horizontally. Browser page zoom is prevented only within the board. Space+primary drag, middle-button drag and hand-tool primary drag pan. Space is intercepted only while the canvas is focused and no input/textarea/select/contenteditable target is active. Sidebar/other controls retain normal scroll and typing behavior.

Two-finger touch pans and pinches about the gesture midpoint using an absolute gesture baseline. This prevents scale drift when per-finger pointer events briefly hit a zoom clamp. Ending one finger does not unexpectedly turn the remaining finger into an editor drag. Pointer capture, focus loss, window blur, cancellation and unmount release navigation state. Native capture listeners arbitrate camera gestures before Konva/editor callbacks.

## Renderer and culling

Exactly three Konva layers exist: non-listening background/grid, scene content, and interaction overlay. All sections/edges/nodes share the scene layer. Grid spacing adapts to zoom and work is bounded to about 500 lines even on very large displays. Section fills are translucent so grid lines remain visible inside sections.

Nodes use section-local top-left coordinates translated once to world space. Edge routes are already world-space and are not translated again. Views reuse Agent 2 font metrics, line wrapping, shape geometry, corner radius and attachment/label calculations. Shape and DOM colors use the renderer's exported tokens pending Agent 7's theme integration. Full text remains available for clipped labels; a small clipping indicator is rendered.

Visible geometry has 120px overscan. Node and section world boxes are culled; edge paths use segment/viewport intersection, so an edge crossing the view remains visible with both endpoint nodes offscreen. Label backgrounds also count for visibility. Selected/preview nodes remain mounted for stable editor refs even outside the view. Stable IDs and memoized views preserve Konva node identity; unchanged nodes ignore section-bounds-only object churn. Cached routes ignore unrelated color/revision changes.

Scene canvases follow devicePixelRatio, including resolution changes. Hit canvases keep Konva's default internal ratio 1, while pointer coordinates remain CSS pixels. Resize does not change the scene. Browser tests cover all six shapes at 50%/200% zoom on a 2× display.

onDraw is called from the scene layer's actual draw event with revision, viewport and timestamp. The host also records last-drawn revision/draw count and camera/culling data attributes for tests. This indicates completed canvas drawing, not proof that the browser displayed a pixel. Agent 8 still needs browser traces for paint/performance acceptance.

## Agent 4 interaction contract

Whiteboard accepts interactions, selectedIds, previews and interactionOverlay, plus a forwarded WhiteboardHandle. The handle exposes getStage() and getNodeRef(id). onStageReady and onNodeRef callbacks expose lifecycle changes. Culled unselected refs may disappear; selected/preview refs are pinned.

BoardInteractions includes node/edge/canvas pointer-down callbacks, node double-click, node drag start/move/end, node transform start/move/end, nodeDraggable predicate, onNodeRef and onNavigationStart. Pointer payloads contain CSS screen coordinates, world coordinates, sectionId and nativeEvent (modifiers/button/pointer identity). Call worldToSection for insertion/commits. Node groups are positioned in WORLD coordinates and expose canonical width/height. Transform/drag events supply the actual Konva event; canonical source protection still belongs to dispatch.

Selection outlines live in the overlay layer, outside node groups, so transformer bounds are not expanded by decoration. Agent 4 should use ignoreStroke for canonical shape bounds, compute committed dimensions from canonical size × transient scale, reset scales to one, convert positions back to section-local coordinates and dispatch one transaction. Rotation remains unsupported.

Pass full valid x/y/width/height per preview node. Preview copies update incident routes without changing the scene or follow metadata; invalid previews are ignored. interactionOverlay is rendered in world coordinates above selection outlines, suitable for a Transformer and connector previews. DOM text overlays belong outside the Konva tree and must convert world to screen consistently.

Enable dragging through nodeDraggable; default is false. Board navigation additionally disables native node dragging during hand/Space/touch pan. onNavigationStart must cancel any editor preview and stop active Konva drags before navigation takes over. Keep the interactions object/callbacks stable to retain memoization. Keep UI editing IDs synchronized with the scene store's setEditingIds.

## Manual editor implementation

Agent 4 now composes this interface in EditorSurface; see [editor integration](editor.md). Whiteboard accepts cursor styling and nativeTransformIds so native-scaled node groups retain canonical children while routes use preview geometry. Selected edges also have overlay highlighting. The app now supports manual editing; its speech/generation fixture remains disconnected from real transport.

## Remaining work

Agents 5–6 provide stream/session inputs. Agent 7 owns full product UI/accessibility and shared themes. Firefox/WebKit, paint latency/FPS and all twelve complete streamed journeys remain unverified; the 5,000-node culling smoke does not establish a performance target.

## V2 presentation

Light and dark surfaces use the same shared DOM/canvas palette. Panels and controls
enter in parallel in 160 ms. New sections, edges and nodes fade in over 160 ms
without changing scene geometry, hit testing, editing or generation scheduling.
The canvas limits concurrent fades to 48; existing objects do not replay an entrance
when they return from viewport culling. Reduced-motion preferences skip animation,
including when enabled while an object is appearing.

The Pan mode button in the footer toggles the existing hand/select tools. H and V,
the separate palette buttons, Space-drag and middle-button drag remain available.
