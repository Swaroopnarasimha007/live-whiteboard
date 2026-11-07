# Manual editor: Agent 4

src/editor implements tools and editing on the canonical store, production layout and Konva board. The app supports all six shapes, arrows/plain lines, Shift selection, grouped movement/resize, labels, colors, locking, duplication, deletion and manual history. Speech/generation and recording remain disconnected. The renderer fixture is a labelled developer aid and is not autosaved.

## Composition

```tsx
import {
  createEditorController,
  EditorSurface,
  ToolPalette,
  SelectionProperties,
} from '../src/editor';
const editor = createEditorController(store, viewport);
// <ToolPalette editor={editor} />
// <SelectionProperties editor={editor} />
// <EditorSurface ref={boardRef} editor={editor} store={store} viewport={viewport} grid={grid} />
// editor.dispose() before viewport/store disposal
```

Create one editor per store. EditorSurface subscribes to editor, scene and camera snapshots and forwards WhiteboardHandle. The framework-independent controller owns no Konva instances; the surface owns pointers, Transformer refs, DOM focus and native scale normalization. There is no second editable scene.

## Tools and gestures

EditorTool is select, hand, rect, roundRect, circle, ellipse, diamond, text, arrow or line. A palette click arms a tool; clicking anywhere, including an existing shape, inserts a new object and returns to Select. Shapes also support HTML5 drag/drop using PALETTE_MIME. Existing objects are never overwritten by an armed shape tool.

Insertion converts screen to world to section-local units. The section under the pointer wins, followed by the active selected section; the live generation section never overrides this choice. The first insertion atomically creates a manual section and node. IDs use m_ plus a UUID. Explicit placement respects overlap. Text begins as an empty manual placeholder and opens its label editor; other shapes have default labels.

Snap is independent of grid and uses 32-unit local steps by default for insertion, movement and keyboard nudges. Native resize handles are continuous; numeric dimensions are exact. Changing tools cancels active drafts/previews. Tool hints explain insertion and connector behavior.

Click selects; Shift+click toggles selection. Selected edges have a highlight, and selected unlocked nodes have resize handles. Movement begins after 3 screen pixels and moves selected nodes together while retaining section IDs. Previews update incident routes without changing the document; release commits one transaction. A selection click without movement adds no history. Escape discards previews. Actual moves/resize/label editing/insertion/connector targeting pause live following; selection alone does not.

Connections take a source then a distinct same-section destination. Locked nodes may be endpoints. A preview follows the pointer; blank canvas/Escape cancels, and success returns to Select. Double-click editing is ignored while connecting, and a drag cannot turn into an accidental double-click edit.

## Resize and label bridges

The native Transformer disables rotation/flipping, limits every node to 24–2,000 units and preserves ratio whenever a circle is selected. Group resize commits every selected node atomically. Canonical size = baseline size × native scale; scales reset to one before commit. node.resize uses fixed sizing.

During resize, Whiteboard nativeTransformIds retain canonical node children while routes and selection use previews, avoiding double scaling. Escape stops native transformation and restores position/scale. Section-origin changes rebase transient groups before paint so upstream reflow and viewport compensation keep the preview aligned under the pointer.

Double-click a node, press Enter with an object selected, or choose Edit label. The DOM textarea follows the camera transform and shared font metrics. Enter saves single-line labels; Shift+Enter starts multiline text. Text/multiline labels use Ctrl/Cmd+Enter. Save/Cancel buttons are accessible alternatives. Composition Enter/Escape does not commit/cancel IME input. Escape, changing tools/selection or beginning navigation cancels drafts. Window blur preserves label drafts while cancelling pointer gestures.

Full labels remain visible in the properties panel even when canvas labels clip. Generated-source nodes require nonempty labels; empty manual placeholders are allowed. Existing node/edge label limits remain 500/200 code units. Color, lock and section-title controls dispatch commands. Width/height (diameter for circles) inputs are UI drafts until Apply size, and do not change displayed geometry while typing.

## History and shortcuts

Duplicate creates fresh IDs, offsets nodes by 32 units, preserves fixed dimensions and remaps internal edges only when both endpoints were copied. Clones are unlocked; original locks remain unchanged. Edge-only duplication is rejected. Delete omits redundant edge commands when selected nodes cascade incident edges. Locked selections reject mutation until unlocked; failures are atomic.

Ctrl/Cmd+D duplicates; Delete/Backspace deletes; Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redoes. Arrows nudge one unit, Shift ten (grid units when snap is enabled). V/H select/hand; R/Shift+R rectangle/rounded rectangle; C/O/D/T circle/ellipse/diamond/text; A/L arrow/line. Shortcuts decline input/textarea/select/contenteditable and composition events and are scoped to the app.

## Concurrency and Agent 6

getSnapshot().interactionInProgress stays true throughout pointer drag/resize and label drafts. Subscribe and defer fresh generation-request construction while true; transcript intake continues. Use canonical scene geometry after commit/cancel, never editor previews/native scales.

The controller supplies store.setEditingIds so generated target updates/deletes reject immediately. Manual commit stamps lastManualRevision against stale in-flight work. Entity revision checks cancel gestures changed externally. Protection refresh is also queued after store notifications, which reject reentrant writes.

Successful import/reset clears selection, drafts, previews and pending connectors even if IDs/revisions match. Store getReplacementVersion is an ephemeral UI lifecycle counter for this distinction. Ordinary generation cancellation does not discard manual drafts; failed import preserves them. No editor lifecycle metadata enters scene export.

## Public API and limits

createEditorController(store,viewport,{uuid?,snapSize?}) exposes getSnapshot, subscribe, getStore, setTool, insert, select, connect, pointerDown, beginMove, beginResize, previewMove, previewResize, commitGesture, editLabel, setLabelDraft, commitLabel, cancelInteraction, escape, clearSelection, setActiveSection, setSnap, setColor, lockSelection, renameSection, deleteSelection, duplicate, setSize, nudge, updatePointer, undo, redo, clearMessage and dispose. Snapshots are frozen; subscriptions return cleanup. Persistent operations return ApplyResult.

UI/helper exports: EditorSurface, ToolPalette, SelectionProperties, PALETTE_MIME, TOOL_HINTS, SHAPE_LABELS and handleEditorKeyDown. Scene/schema/history/persistence ownership remains unchanged. Large selections still obey the core 200-command atomic limit. Coordinate/padding limits and straight-edge crossings remain as documented. Performance/FPS/paint, OS IME variants and Firefox/WebKit are not claimed. Agent 7 owns the final shell; current properties share the scrollable sidebar.
