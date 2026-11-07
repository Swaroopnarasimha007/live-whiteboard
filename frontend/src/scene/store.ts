import { createStore } from 'zustand/vanilla';
import {
  commandMetaSchema,
  createSceneSchema,
  DEFAULT_LIMITS,
  idSchema,
  manualCommandSchema,
  operationSchema,
  type ApplyResult,
  type Command,
  type CommandMeta,
  type ErrorCode,
  type Scene,
  type SceneLayout,
  type SceneLimits,
} from '../contracts';
import {
  applyHistoryPatches,
  captureHistory,
  guardHistory,
  historyMatches,
  historyPriorVersions,
  rebaseHistory,
  updateFieldVersions,
  type HistoryEntry,
} from './history';
import { reduceScene, type ReducerState } from './reducer';
import {
  emptyScene,
  equal,
  failure,
  freeze,
  reject,
  SceneError,
  shareScene,
  stable,
} from './utils';
import { validateLayout } from './geometry';

export interface Diagnostic {
  code: ErrorCode | 'LAYOUT_INFO' | 'CALLBACK';
  message: string;
  requestId?: string;
  transactionId?: string;
}
export interface SceneStoreOptions {
  documentId: string;
  layout: SceneLayout;
  initialScene?: unknown;
  sessionEpoch?: number;
  limits?: Partial<SceneLimits>;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
  /** Session coordinator MUST abort active generation on successful import/reset. */
  onSessionInvalidated?: (epoch: number) => void;
  onLayout?: (event: {
    anchorDelta?: { x: number; y: number };
    diagnostics: readonly string[];
  }) => void;
}
interface Envelope {
  commands: readonly Command[];
  meta: CommandMeta;
  signature: string;
}

export function createSceneStore(options: SceneStoreOptions) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (
    !Number.isSafeInteger(limits.maxEntities) ||
    limits.maxEntities < 1 ||
    !Number.isSafeInteger(limits.maxSections) ||
    limits.maxSections < 1
  )
    throw new Error('Invalid scene limits');
  const schema = createSceneSchema(limits);
  const initial = freeze(
    schema.parse(options.initialScene ?? emptyScene(idSchema.parse(options.documentId))),
  );
  let state: ReducerState = { scene: initial, tombstones: new Set(), additions: new Map() };
  const observable = createStore<Scene>(() => initial);
  let epoch = options.sessionEpoch ?? 0;
  let replacementVersion = 0;
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid session epoch');
  let disposed = false;
  let busy = false;
  let draining = false;
  const editingIds = new Set<string>();
  const pending: Envelope[] = [];
  const sequences = new Map<
    string,
    { signature: string; result: ApplyResult; requestId?: string }
  >();
  const transactions = new Map<
    string,
    { signature: string; result: ApplyResult; requestId?: string }
  >();
  const endedRequests = new Set<string>();
  const versions = new Map<string, number>();
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  const diagnosticListeners = new Set<(diagnostic: Diagnostic) => void>();
  const sessionListeners = new Set<(epoch: number) => void>();
  const subscriptions = new Set<() => void>();
  const subscribeScene = (listener: (scene: Scene, previous: Scene) => void) => {
    if (disposed) return () => {};
    const unsubscribe = observable.subscribe(listener);
    const cleanup = () => {
      unsubscribe();
      subscriptions.delete(cleanup);
    };
    subscriptions.add(cleanup);
    return cleanup;
  };
  const notify = <T>(callback: ((value: T) => void) | undefined, value: T) => {
    try {
      callback?.(value);
    } catch {
      /* Consumer callbacks cannot undo or interrupt an atomic commit. */
    }
  };
  const report = (diagnostic: Diagnostic) => {
    diagnostics.push(freeze(diagnostic));
    if (diagnostics.length > 200) diagnostics.shift();
    notify(options.onDiagnostic, diagnostic);
    for (const listener of diagnosticListeners) notify(listener, diagnostic);
  };
  const reportResult = (result: ApplyResult, meta?: CommandMeta) => {
    if (result.status === 'rejected')
      report({
        code: result.code,
        message: result.message,
        ...(meta
          ? {
              transactionId: meta.transactionId,
              ...(meta.requestId ? { requestId: meta.requestId } : {}),
            }
          : {}),
      });
    return result;
  };
  const sequenceKey = (meta: CommandMeta) => `${meta.requestId}/${meta.sequence}`;
  const transactionKey = (meta: CommandMeta) =>
    `${meta.sessionEpoch}/${meta.source}/${meta.source === 'generated' ? `${meta.requestId}/` : ''}${meta.transactionId}`;
  const remember = (envelope: Envelope, result: ApplyResult) => {
    const record = {
      signature: envelope.signature,
      result,
      ...(envelope.meta.requestId ? { requestId: envelope.meta.requestId } : {}),
    };
    transactions.set(transactionKey(envelope.meta), record);
    if (envelope.meta.source === 'generated') sequences.set(sequenceKey(envelope.meta), record);
  };
  const publish = (next: ReducerState) => {
    const previous = state.scene;
    const scene = shareScene(previous, next.scene);
    updateFieldVersions(previous, scene, versions);
    state = { ...next, scene };
    // Subscribe wrapper isolates individual listener exceptions.
    observable.setState(scene, true);
  };
  const apply = (envelope: Envelope, retry = false): ApplyResult => {
    const { commands, meta } = envelope;
    try {
      if (meta.sessionEpoch !== epoch)
        throw new SceneError('STALE_EPOCH', 'Obsolete session epoch');
      if (meta.source === 'generated' && meta.baseRevision! > state.scene.revision)
        throw new SceneError('FUTURE_REVISION', 'Request revision is ahead of the document');
      const previous = state.scene;
      const reduced = reduceScene(state, commands, meta, {
        layout: options.layout,
        limits,
        editingIds,
      });
      if (reduced.state === state) {
        const result: ApplyResult = { status: 'duplicate', revision: previous.revision };
        remember(envelope, result);
        return result;
      }
      // Compute history before subscribers run; reentrant persistent writes are rejected.
      const nextScene = reduced.state.scene;
      const entry =
        meta.source === 'manual'
          ? captureHistory(previous, nextScene, versions, meta.transactionId)
          : undefined;
      updateFieldVersions(previous, nextScene, versions);
      if (meta.source === 'manual') {
        if (entry!.patches.length) undoStack.push(guardHistory(entry!, versions));
        if (undoStack.length > 100) undoStack.shift();
        redoStack.length = 0;
      }
      const result: ApplyResult = { status: 'applied', revision: nextScene.revision };
      remember(envelope, result);
      publish(reduced.state);
      notify(options.onLayout, {
        diagnostics: reduced.diagnostics,
        ...(reduced.anchorDelta ? { anchorDelta: reduced.anchorDelta } : {}),
      });
      for (const message of reduced.diagnostics) report({ code: 'LAYOUT_INFO', message });
      return result;
    } catch (error) {
      if (error instanceof SceneError && error.code === 'MISSING_DEPENDENCY') {
        if (!retry && pending.reduce((n, e) => n + e.commands.length, 0) + commands.length > 200)
          return reportResult(
            reject('PENDING_LIMIT', 'Pending operation limit (200) reached'),
            meta,
          );
        const result: ApplyResult = { status: 'pending', reason: error.message };
        if (!retry) pending.push(envelope);
        remember(envelope, result);
        return result;
      }
      const result = failure(error);
      remember(envelope, result);
      return reportResult(result, meta);
    }
  };
  const drain = () => {
    if (draining) return;
    draining = true;
    try {
      let progress = true;
      while (progress) {
        progress = false;
        for (let i = 0; i < pending.length;) {
          const result = apply(pending[i]!, true);
          if (result.status === 'pending') i++;
          else {
            pending.splice(i, 1);
            progress = true;
          }
        }
      }
    } finally {
      draining = false;
    }
  };
  const dispatchTransaction = (input: readonly unknown[], inputMeta: unknown): ApplyResult => {
    if (disposed) return reject('DISPOSED', 'Store is disposed');
    if (busy) return reject('REENTRANT', 'Dispatch during a store notification is not allowed');
    busy = true;
    try {
      const meta = commandMetaSchema.parse(inputMeta);
      if (meta.sessionEpoch !== epoch)
        return reportResult(reject('STALE_EPOCH', 'Obsolete session epoch'), meta);
      if (!Array.isArray(input) || input.length === 0 || input.length > 200)
        return reportResult(reject('VALIDATION', 'Transaction must contain 1–200 commands'), meta);
      const commands = input.map((command) =>
        (meta.source === 'manual' ? manualCommandSchema : operationSchema).parse(command),
      );
      // Request/sequence is transport identity; retry callers may use a fresh transaction ID.
      const signature = stable({ commands, meta: { ...meta, transactionId: undefined } });
      const envelope = freeze({ commands, meta, signature });
      const old = meta.source === 'generated' ? sequences.get(sequenceKey(meta)) : undefined;
      if (old) {
        if (old.signature !== signature)
          return reportResult(
            reject('REPLAY_CONFLICT', 'Request sequence reused with different content or metadata'),
            meta,
          );
        return old.result.status === 'applied' || old.result.status === 'duplicate'
          ? { status: 'duplicate', revision: state.scene.revision }
          : old.result;
      }
      const tx = transactions.get(transactionKey(meta));
      if (tx) {
        if (tx.signature !== signature)
          return reportResult(
            reject('TRANSACTION_REUSE', 'Use a fresh transaction ID for each atomic transaction'),
            meta,
          );
        return tx.result.status === 'applied' || tx.result.status === 'duplicate'
          ? { status: 'duplicate', revision: state.scene.revision }
          : tx.result;
      }
      if (meta.requestId && endedRequests.has(meta.requestId))
        return reportResult(
          reject('REQUEST_ENDED', 'Request has already ended or been cancelled'),
          meta,
        );
      const result = apply(envelope);
      if (result.status === 'applied') drain();
      return result;
    } catch (error) {
      return reportResult(failure(error));
    } finally {
      busy = false;
    }
  };

  const history = (direction: 'undo' | 'redo'): ApplyResult => {
    if (disposed) return reject('DISPOSED', 'Store is disposed');
    if (busy) return reject('REENTRANT', 'History during a notification is not allowed');
    const source = direction === 'undo' ? undoStack : redoStack;
    const destination = direction === 'undo' ? redoStack : undoStack;
    const entry = source.pop();
    if (!entry) return reject('EMPTY_HISTORY', 'No history transaction available');
    busy = true;
    try {
      if (!historyMatches(entry, state.scene, versions, direction))
        throw new SceneError(
          'HISTORY_CONFLICT',
          'A field required by this transaction changed; transaction skipped',
        );
      const previous = state.scene;
      const next = applyHistoryPatches(entry, previous, direction);
      const touched = new Set(
        entry.patches.filter((p) => p.collection !== 'sections').map((p) => p.id),
      );
      for (const id of touched) {
        const entity = previous.nodes[id] ?? previous.edges[id];
        const unlocking = entry.patches.some(
          (p) =>
            p.id === id &&
            p.field === 'locked' &&
            (direction === 'undo' ? p.before : p.after) === false,
        );
        if (editingIds.has(id) || (entity?.locked && !unlocking))
          throw new SceneError(
            'HISTORY_CONFLICT',
            'Entity is locked or actively edited; transaction skipped',
          );
      }
      const measureNodeIds = [...touched].filter((id) => next.nodes[id]?.sizing === 'auto');
      const meta: CommandMeta = {
        source: 'manual',
        sessionEpoch: epoch,
        transactionId: `history_${previous.revision}`,
      };
      const output = validateLayout(
        options.layout.layoutTransaction(
          freeze({
            previousScene: previous,
            scene: freeze(structuredClone(next)),
            commands: [],
            meta,
            measureNodeIds,
            addedNodeIds: [],
          }),
        ),
      );
      for (const id of measureNodeIds)
        if (!output.nodes[id]) throw new SceneError('LAYOUT', `Missing history geometry: ${id}`);
      for (const [id, geometry] of Object.entries(output.nodes)) {
        const node = next.nodes[id];
        if (
          !node ||
          Object.keys(geometry).some((k) => !['x', 'y', 'width', 'height'].includes(k)) ||
          geometry.x !== node.x ||
          geometry.y !== node.y ||
          (!measureNodeIds.includes(id) &&
            (geometry.width !== node.width || geometry.height !== node.height))
        )
          throw new SceneError('LAYOUT', 'History layout moved or resized unrelated geometry');
        Object.assign(node, geometry);
      }
      if (Object.keys(output.sections).length !== Object.keys(next.sections).length)
        throw new SceneError('LAYOUT', 'Missing section geometry');
      for (const [id, geometry] of Object.entries(output.sections)) {
        if (
          !next.sections[id] ||
          Object.keys(geometry).some((k) => !['origin', 'bounds'].includes(k))
        )
          throw new SceneError('LAYOUT', 'Invalid section geometry');
        Object.assign(next.sections[id]!, geometry);
      }
      next.revision = previous.revision + 1;
      const tombstones = new Set(state.tombstones);
      for (const id of Object.keys(previous.sections)) if (!next.sections[id]) tombstones.add(id);
      for (const collection of ['nodes', 'edges'] as const) {
        for (const id of Object.keys(previous[collection]))
          if (!next[collection][id]) tombstones.add(id);
        for (const [id, entity] of Object.entries(next[collection])) {
          if (!equal(entity, previous[collection][id])) {
            entity.revision =
              Math.max(entity.revision, previous[collection][id]?.revision ?? 0) + 1;
            if (touched.has(id)) entity.lastManualRevision = next.revision;
          }
        }
      }
      const parsed = schema.parse(next);
      const beforeInverse = historyPriorVersions(entry, versions);
      publish({ ...state, scene: parsed, tombstones });
      rebaseHistory(source, entry, state.scene, versions, direction);
      destination.push(guardHistory({ ...entry, prior: beforeInverse }, versions));
      // Expectations must reflect metadata and auto-geometry derived by undo/redo.
      const guarded = destination.at(-1)!;
      for (const patch of guarded.patches) {
        const entity = (
          state.scene[patch.collection] as unknown as Record<string, Record<string, unknown>>
        )[patch.id];
        const value = patch.field === null ? entity : entity?.[patch.field];
        if (direction === 'undo') patch.before = value;
        else patch.after = value;
      }
      notify(options.onLayout, {
        diagnostics: output.diagnostics ?? [],
        ...(output.anchorDelta ? { anchorDelta: output.anchorDelta } : {}),
      });
      drain();
      return { status: 'applied', revision: next.revision };
    } catch (error) {
      return reportResult(
        error instanceof SceneError
          ? failure(error)
          : reject('HISTORY_CONFLICT', error instanceof Error ? error.message : String(error)),
      );
    } finally {
      busy = false;
    }
  };

  const invalidate = () => {
    epoch++;
    for (const envelope of pending)
      remember(envelope, reject('STALE_EPOCH', 'Session invalidated'));
    pending.length = 0;
    editingIds.clear();
    endedRequests.clear();
    notify(options.onSessionInvalidated, epoch);
    for (const listener of sessionListeners) notify(listener, epoch);
  };
  const replaceScene = (input: unknown): ApplyResult => {
    if (disposed) return reject('DISPOSED', 'Store is disposed');
    if (busy) return reject('REENTRANT', 'Import during a notification is not allowed');
    busy = true;
    try {
      const scene = schema.parse(input);
      replacementVersion++;
      invalidate();
      undoStack.length = 0;
      redoStack.length = 0;
      versions.clear();
      const tombstones = new Set(state.tombstones);
      for (const collection of ['nodes', 'edges', 'sections'] as const)
        for (const id of Object.keys(state.scene[collection]))
          if (!scene[collection][id]) tombstones.add(id);
      state = { scene: freeze(scene), tombstones, additions: new Map() };
      observable.setState(state.scene, true);
      return { status: 'applied', revision: scene.revision };
    } catch (error) {
      return reportResult(failure(error, 'IMPORT'));
    } finally {
      busy = false;
    }
  };

  return {
    dispatch: (command: unknown, meta: unknown) => dispatchTransaction([command], meta),
    dispatchTransaction,
    getSnapshot: () => state.scene,
    subscribe: (listener: (scene: Scene, previous: Scene) => void) =>
      subscribeScene((scene, previous) => {
        try {
          listener(scene, previous);
        } catch (error) {
          report({
            code: 'CALLBACK',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    subscribeSelector: <T>(
      selector: (scene: Scene) => T,
      listener: (value: T, previous: T) => void,
      equality: (a: T, b: T) => boolean = Object.is,
    ) => {
      let selected = selector(state.scene);
      return subscribeScene((scene) => {
        try {
          const next = selector(scene);
          if (!equality(selected, next)) {
            const previous = selected;
            selected = next;
            listener(next, previous);
          }
        } catch (error) {
          report({
            code: 'CALLBACK',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
    undo: () => history('undo'),
    redo: () => history('redo'),
    getHistoryState: () => ({ undoCount: undoStack.length, redoCount: redoStack.length }),
    exportScene: () => JSON.stringify(schema.parse(state.scene)),
    importScene: (json: string): ApplyResult => {
      try {
        return replaceScene(JSON.parse(json));
      } catch (error) {
        return reportResult(failure(error, 'IMPORT'));
      }
    },
    reset: (documentId = options.documentId) => replaceScene(emptyScene(documentId)),
    /** Stops late chunks without clearing the document or manual history. */
    cancelGeneration: () => {
      if (!disposed && !busy) {
        busy = true;
        try {
          invalidate();
        } finally {
          busy = false;
        }
      }
      return epoch;
    },
    getSessionEpoch: () => epoch,
    subscribeSessionInvalidation: (listener: (epoch: number) => void) => {
      if (disposed) return () => {};
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    },
    /** UI lifecycle counter: successful import/reset only; unlike epoch, not generation cancellation. */
    getReplacementVersion: () => replacementVersion,
    setEditingIds: (ids: readonly string[]) => {
      if (!disposed && !busy) {
        const parsed = ids.map((id) => idSchema.parse(id));
        editingIds.clear();
        parsed.forEach((id) => editingIds.add(id));
      }
    },
    getPendingCount: () => pending.reduce((n, e) => n + e.commands.length, 0),
    getOperationResult: (requestId: string, sequence: number): ApplyResult | undefined => {
      const record = sequences.get(`${requestId}/${sequence}`);
      return record ? { ...record.result } : undefined;
    },
    /** Explicit retry reopens only failed receipts; successful identities remain deduplicated. */
    beginRequest: (requestId: string, sessionEpoch: number, retry = false): ApplyResult => {
      if (disposed) return reject('DISPOSED', 'Store is disposed');
      if (busy) return reject('REENTRANT', 'Request lifecycle during notification is not allowed');
      if (!idSchema.safeParse(requestId).success) return reject('VALIDATION', 'Invalid request ID');
      if (sessionEpoch !== epoch) return reject('STALE_EPOCH', 'Obsolete session epoch');
      if (endedRequests.has(requestId) && !retry)
        return reject('REQUEST_ENDED', 'Use explicit retry to reopen a finished request');
      if (retry) {
        if (pending.some((e) => e.meta.requestId === requestId))
          return reject('VALIDATION', 'Finish the prior request before retrying');
        for (const map of [sequences, transactions])
          for (const [key, record] of map) {
            if (
              record.requestId === requestId &&
              record.result.status !== 'applied' &&
              record.result.status !== 'duplicate'
            )
              map.delete(key);
          }
        endedRequests.delete(requestId);
      }
      return { status: 'duplicate', revision: state.scene.revision };
    },
    finishRequest: (requestId: string): readonly Diagnostic[] => {
      if (disposed || busy) return [];
      busy = true;
      try {
        endedRequests.add(requestId);
        const unresolved: Diagnostic[] = [];
        for (let i = pending.length - 1; i >= 0; i--) {
          const envelope = pending[i]!;
          if (envelope.meta.requestId !== requestId) continue;
          const diagnostic: Diagnostic = {
            code: 'MISSING_DEPENDENCY',
            message: 'Unresolved dependencies at request end (including possible cycles)',
            requestId,
            transactionId: envelope.meta.transactionId,
          };
          unresolved.unshift(diagnostic);
          report(diagnostic);
          remember(envelope, reject('MISSING_DEPENDENCY', diagnostic.message));
          pending.splice(i, 1);
        }
        return freeze(unresolved);
      } finally {
        busy = false;
      }
    },
    getDiagnostics: () => [...diagnostics],
    subscribeDiagnostics: (listener: (diagnostic: Diagnostic) => void) => {
      diagnosticListeners.add(listener);
      return () => {
        diagnosticListeners.delete(listener);
      };
    },
    dispose: () => {
      if (disposed || busy) return;
      busy = true;
      try {
        invalidate();
        disposed = true;
        subscriptions.forEach((cleanup) => cleanup());
        sequences.clear();
        transactions.clear();
        versions.clear();
        diagnosticListeners.clear();
        sessionListeners.clear();
        undoStack.length = 0;
        redoStack.length = 0;
      } finally {
        busy = false;
      }
    },
  };
}
export type SceneStore = ReturnType<typeof createSceneStore>;
