# Protocol v1 baseline

`src/contracts/index.ts` publishes schema-derived canonical types, Zod schemas, error codes, fixtures and the geometry adapter interface. `src/scene/index.ts` publishes the store, pure reducer, persistence controllers and selectors. These interfaces compile together and are ready for downstream implementation. Shared changes remain coordinated by Agent 0. Semantics follow the preserved [master plan](Live_Whiteboard_Master_Plan.md).

## Validation and defaults

Use operationSchema for generated records, manualCommandSchema for editor commands, commandMetaSchema for metadata, sceneSchema for default-limit documents and generationRequestSchema for outbound context. dispatch validates unknown input itself. Never copy shared types into downstream modules.

- IDs: 1–64 ASCII letters, digits, underscores/hyphens; prototype-related names are rejected. New generated IDs use g_...; manual IDs use m_ plus a UUID. Transport/session applies the request prefix to NEW model IDs; existing canonical IDs remain unchanged.
- Node labels: 500 UTF-16 code units; edge labels: 200; section titles: 120. Generated node labels must contain non-whitespace text. Manual placeholders allow empty labels. Edges may be unlabelled.
- World coordinates/origins: finite, within ±100,000 world units. Node dimensions: 24–2,000; circles have equal dimensions. Section/visible bounds have nonnegative extents up to 200,000. Viewport translations are finite screen pixels, independent of world-coordinate bounds. Zoom: 0.15–4.
- Default document limit: 5,000 nodes + edges, 100 sections; override store limits and use createSceneSchema(limits) for matching validation. The outbound v1 request schema retains default limits.
- Scene validation checks globally unique IDs, matching record keys, source namespaces, unique section order, section membership, valid revisions and distinct same-section edge endpoints.
- Strict objects reject extra keys, unsafe prototypes, accessors, cycles and excessive nesting. Unsupported enums and non-finite geometry are rejected.
- Node color defaults neutral. Edge color defaults neutral, kind arrow and label empty. Defaults are centralized in command validation.

Snapshots are deeply frozen at runtime and structurally share unchanged entities. Exports contain only canonical Scene JSON with schemaVersion 1; UI state, history, audio and transport receipts are excluded.

## Stream operations and examples

One JSON object per NDJSON line. All seven valid examples and invalid fixtures are exported from src/contracts/examples.ts.

```jsonl
{"op":"section.add","id":"g_r1_topic","title":"Request flow"}
{"op":"node.add","id":"g_r1_browser","section":"g_r1_topic","type":"rect","label":"Browser","at":[0,0],"color":"blue"}
{"op":"node.add","id":"g_r1_server","section":"g_r1_topic","type":"roundRect","label":"Server","place":{"rightOf":"g_r1_browser"}}
{"op":"edge.add","id":"g_r1_e1","section":"g_r1_topic","from":"g_r1_browser","to":"g_r1_server","label":"Request"}
{"op":"node.update","id":"g_r1_server","set":{"label":"API server"}}
{"op":"edge.update","id":"g_r1_e1","set":{"color":"green"}}
{"op":"entity.delete","id":"g_r1_e1"}
```

at always means section-local world coordinates. place accepts exactly one rightOf/below/leftOf/above. Never supply both. Layout resolves missing positions and generated-add collisions against the latest committed scene. Nodes start auto-sized; the client supplies canonical dimensions.

node.update.set allows label, color, type and at. edge.update.set allows label and color. Empty updates, endpoint mutation, section deletion, cross-section edges and self-loops are unsupported. Node deletion atomically removes incident edges after checking every affected entity's protection.

Invalid examples include **proto**/toString IDs, type svg, node.update.set.width, both at and place, and Infinity coordinates.

## Manual commands, metadata and transactions

Manual commands include all compact operations, with empty placeholders allowed, plus:

```ts
{ op: 'node.resize', id, width: 240, height: 120, at: [32, 48] } // optional at; sets sizing=fixed
{ op: 'entity.lock', id, locked: true }
{ op: 'section.rename', id, title: 'Storage' }
```

CommandMeta always requires source, sessionEpoch and transactionId. Generated operations additionally require requestId, sequence and baseRevision. Persistent command writes use store.dispatch or store.dispatchTransaction. A transaction has 1–200 commands in dependency order and commits one document revision. Each changed node/edge revision advances once; lastManualRevision uses the DOCUMENT revision of its latest manual change. Derived layout changes do not mark unrelated entities manually edited. No-op commands return duplicate without advancing revision.

```ts
import { createSceneStore } from '../src/scene';
import type { SceneLayout } from '../src/contracts';

function composeScene(layout: SceneLayout) {
  const store = createSceneStore({
    documentId: 'demo',
    layout,
    onSessionInvalidated: (epoch) => {
      // Agent 6: abort active transport and use this epoch for future requests.
      console.info('Generation invalidated', epoch);
    },
  });
  store.dispatch(
    { op: 'section.add', id: 'g_r1_topic', title: 'Request flow' },
    {
      source: 'generated',
      requestId: 'r1',
      sequence: 0,
      baseRevision: 0,
      sessionEpoch: store.getSessionEpoch(),
      transactionId: 'r1_0',
    },
  );
  return store;
}
```

The caller supplies Agent 2's adapter; no fallback production geometry exists. Test-only geometry is excluded from public exports. UI previews and viewport/tool state stay outside the document. Use a single transaction when a drag/resize commits, and setEditingIds to protect active editing.

## Concurrency and lifecycle

Generated updates/deletes reject manual entities, locks, active edits and targets with lastManualRevision greater than baseRevision. Manual entities can be endpoints and placement anchors. Protection also applies to incident edges during delete. Missing references wait up to 200 COMMANDS across pending transactions. Pending batches publish no partial changes. Successful commits re-evaluate dependencies against current state; deleted references reject immediately.

Transport identity is requestId + sequence. Normalized content and metadata other than transactionId must match; retries may use a fresh transaction ID. Transaction IDs cannot be reused for different content. Identical original additions are no-ops even after subsequent edits; conflicting IDs reject. Sequence receipts survive request end and epochs until disposal.

Agent 5 scopes generated transaction keys by epoch/source/request/transaction; manual keys retain epoch/source/transaction scope. beginRequest(requestId, epoch, retry=false) rejects obsolete epochs and closed requests unless explicitly reopening. Explicit retry removes only failed receipts for that request, retaining applied/duplicate identities; it requires the prior pending queue to be finished. Keep the original immutable request, base revision, prefix and record order. getOperationResult(requestId, sequence) exposes a copy of the latest receipt so the consumer can reconcile internally resolved dependencies. These APIs are ephemeral and do not change serialized scene JSON.

Call finishRequest(requestId) after the consumer queue drains. It reports/rejects all unresolved references (including cycles) and prevents new records for that request. Also finish partial/disconnected requests so pending operations cannot resolve later unintentionally. Applied results remain. Single-request scheduling belongs to Agent 6.

cancelGeneration advances epoch and clears pending work while retaining scene/history. reset replaces the document; the UI/session supplies the confirmed reset action. Successful import/reset validates first, advances epoch, invokes onSessionInvalidated and clears history. Failure preserves scene, epoch, history and pending work. Tombstones survive resets/imports for the store lifetime; a validated import may explicitly restore the same canonical entity. Import cancels old requests; new generation references imported entities instead of re-adding their IDs.

subscribeSessionInvalidation(listener) returns cleanup and observes generation cancellation, successful import/reset and disposal, including changes that do not publish a scene commit. The stream consumer uses it to abort waiting reads and cancel scheduled frames immediately.

Persistent writes during notification return REENTRANT; schedule follow-up work after notification returns. Subscriber errors are diagnosed without rolling back a committed transaction. Dispose autosave before the store; subscriptions return cleanup functions.

## Manual history

UI integrations can read store.getReplacementVersion(), which increments on successful import/reset but not generation cancellation. It is ephemeral lifecycle state used by the manual editor to cancel drafts/previews on same-revision document replacement and is excluded from Scene JSON.

undo/redo are store methods. Manual history is capped at 100 transactions; generated changes are excluded. Entries use inverse FIELD patches and revision/lifecycle stamps, preserving unrelated newer fields/entities. ABA edits (changed away and back) still conflict. Own inverses rebase only their restored stamps so consecutive undo/redo works without masking external edits. New manual edits clear redo.

Deletion records incident edges for restoration. History remeasures auto-sized nodes and section geometry atomically. Locks, active edits, required-field changes or new dependencies preventing removal yield HISTORY_CONFLICT and skip the transaction. Geometry and entity/document revisions remain valid and monotonic.

## Geometry injection: Agent 2

The production adapter now exists at src/layout/index.ts. See [layout integration](layout.md) and the [Agent 2 handoff](agent-handoffs/agent-2.md) for font preparation, typography, placement, section reflow and routing. The shared SceneLayout contract below remains unchanged.

Implement SceneLayout.layoutTransaction(input) in src/layout. Inputs are immutable clones: previousScene, provisional semantic scene, ordered commands, meta, measureNodeIds and addedNodeIds. New nodes have provisional 24×24 dimensions and explicit at or provisional 0,0; these are never published as final geometry.

Return nodes[id] = {x,y,width,height} for EVERY measureNodeId, and sections[id] = {origin,bounds} for EVERY section. Optional diagnostics/anchorDelta are forwarded through onLayout. layoutOutputSchema and the complete scene schema validate output before commit. Geometry patches cannot change labels, IDs, revisions or ownership.

- Measure/position new nodes from command at/place, using current geometry and newly measured anchors in command order. Relative placement uses the specified 64-unit gap.
- Remeasure existing auto-sized label/type edits without changing position. Fixed-size nodes keep dimensions. Explicit manual positions, including overlap, are respected.
- Unrelated established nodes cannot move/resize. Section origins/bounds may reflow downstream; return viewport compensation through anchorDelta.
- History calls have empty commands, no addedNodeIds and affected surviving auto-sized measureNodeIds. Preserve restored positions, remeasure labels and recalculate all sections.
- Adapter errors or invalid geometry must not partially commit. Scene code never imports React or Konva.

## Persistence and selectors

createIndexedDbPersistence({databaseName?, key?}) stores canonical scenes. createSceneAutosave(store, persistence, {debounceMs: 300, onStatus}) subscribes to commits. restore() is explicit and validates before import. Serialized writes prevent a slower older save from replacing newer work. Corrupt/stale restores preserve the current scene. flush() retries explicitly. Quota/open/read/write failures appear in getStatus/subscribe/onStatus and leave drawing available; Agent 7 must display them. Await dispose({flush: true}) for an optional final save. IndexedDB awaits transaction completion.

Store methods: dispatch, dispatchTransaction, getSnapshot, subscribe, subscribeSelector, undo, redo, getHistoryState, importScene, exportScene, reset, cancelGeneration, getSessionEpoch, subscribeSessionInvalidation, getReplacementVersion, setEditingIds, getPendingCount, getOperationResult, beginRequest, finishRequest, getDiagnostics, subscribeDiagnostics and dispose.

Selectors: selectNode, selectEdge, selectEntity, selectSection, selectSections, selectSectionNodes, selectSectionEdges. Use createSectionNodesSelector(id)/createSectionEdgesSelector(id) per mounted section to preserve array identity across unrelated edits.

## Results and diagnostics

ApplyResult is applied/duplicate with revision, pending with reason, or rejected with code/message. Diagnostic retention is capped at 200; autosave has a separate observable status. errorCodeSchema publishes the enum.

| Codes                                             | Meaning                                      |
| ------------------------------------------------- | -------------------------------------------- |
| VALIDATION                                        | Invalid command/metadata/namespace           |
| STALE_EPOCH, FUTURE_REVISION                      | Obsolete session or impossible request base  |
| DUPLICATE_ID, REPLAY_CONFLICT, TRANSACTION_REUSE  | Conflicting identity/replay                  |
| TOMBSTONED                                        | Deleted identity cannot be reused/referenced |
| MISSING_DEPENDENCY, PENDING_LIMIT                 | Unresolved reference or pending capacity     |
| PROTECTED, LOCKED, ACTIVE_EDIT, STALE_MANUAL_EDIT | Target protection                            |
| WRONG_ENTITY, INVALID_REFERENCE                   | Wrong target kind or edge/anchor             |
| LIMIT, LAYOUT                                     | Capacity or invalid/failed geometry          |
| HISTORY_CONFLICT, EMPTY_HISTORY                   | Inverse skipped or no history                |
| IMPORT                                            | Invalid serialized document                  |
| DISPOSED, REQUEST_ENDED, REENTRANT                | Invalid lifecycle/write timing               |

Generation requests validate version 1, transcript intervals/unique segments, geometry, base revision, selection and graph references. contextComplete must be true and omittedEntityCount zero. Agent 6 still owns immutable fresh snapshot construction, interaction deferral and the 256 KiB UTF-8 context budget. Agent 5 owns byte framing, per-line limits and consumer queue limits.
