import { describe, expect, it, vi } from 'vitest';
import { sceneSchema, type SceneLayout } from '../contracts';
import { reduceScene } from './reducer';
import { selectSectionNodes, selectSections } from './selectors';
import { manualNodeId, manualSectionId, setup, testLayout } from './test-helpers';

describe('canonical command store', () => {
  it('applies defaults, measures geometry and commits one revision per atomic transaction', () => {
    const { store, generated } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(
      store.dispatchTransaction(
        [
          { op: 'section.add', id: 'g_s', title: 'Flow' },
          {
            op: 'node.add',
            id: 'g_a',
            section: 'g_s',
            type: 'rect',
            label: 'Browser',
            at: [12, 24],
          },
          {
            op: 'node.add',
            id: 'g_b',
            section: 'g_s',
            type: 'circle',
            label: 'Server',
            place: { rightOf: 'g_a' },
          },
          { op: 'edge.add', id: 'g_e', section: 'g_s', from: 'g_a', to: 'g_b' },
        ],
        generated(),
      ),
    ).toEqual({ status: 'applied', revision: 1 });
    const scene = store.getSnapshot();
    expect(scene.nodes.g_a).toMatchObject({
      x: 12,
      y: 24,
      width: 80,
      color: 'neutral',
      revision: 1,
      lastManualRevision: 0,
    });
    expect(scene.nodes.g_b!.x).toBe(156);
    expect(scene.nodes.g_b!.width).toBe(scene.nodes.g_b!.height);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(sceneSchema.safeParse(scene).success).toBe(true);
  });
  it('keeps reducer inputs immutable and deterministic', () => {
    const { store, generated } = setup();
    const state = {
      scene: store.getSnapshot(),
      tombstones: new Set<string>(),
      additions: new Map<string, string>(),
    };
    const commands = [{ op: 'section.add' as const, id: 'g_s', title: 'Flow' }];
    const context = {
      layout: testLayout,
      limits: { maxEntities: 5_000, maxSections: 100 },
      editingIds: new Set<string>(),
    };
    const meta = generated();
    expect(reduceScene(state, commands, meta, context)).toEqual(
      reduceScene(state, commands, meta, context),
    );
    expect(state.scene.revision).toBe(0);
    expect(state.additions.size).toBe(0);
  });
  it('preserves unchanged references and selector subscriptions', () => {
    const { store, addSection, addNode, generated } = setup();
    addSection();
    addNode();
    const scene = store.getSnapshot();
    const nodes = selectSectionNodes(scene, 'g_s');
    const sections = selectSections(scene);
    const listener = vi.fn();
    store.subscribeSelector((s) => s.nodes.g_n, listener);
    addNode('g_other');
    expect(store.getSnapshot().nodes.g_n).toBe(scene.nodes.g_n);
    expect(listener).not.toHaveBeenCalled();
    expect(selectSections(store.getSnapshot())).toBe(sections);
    expect(selectSectionNodes(scene, 'g_s')).toBe(nodes);
    expect(() => {
      store.getSnapshot().nodes.g_n!.x = 123;
    }).toThrow();
    store.dispatch({ op: 'node.update', id: 'g_n', set: { color: 'red' } }, generated());
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('deduplicates sequences, replays and rejects conflicting IDs', () => {
    const { store, addSection, generated } = setup();
    addSection();
    const command = { op: 'node.add', id: 'g_n', section: 'g_s', type: 'rect', label: 'One' };
    const meta = generated();
    expect(store.dispatch(command, meta).status).toBe('applied');
    const revision = store.getSnapshot().revision;
    expect(store.dispatch(command, meta)).toEqual({ status: 'duplicate', revision });
    expect(store.dispatch(command, { ...meta, transactionId: 'retry_tx' })).toEqual({
      status: 'duplicate',
      revision,
    });
    expect(store.dispatch({ ...command, label: 'Different' }, meta)).toMatchObject({
      code: 'REPLAY_CONFLICT',
    });
    expect(store.dispatch(command, generated()).status).toBe('duplicate');
    expect(store.dispatch({ ...command, label: 'Different' }, generated())).toMatchObject({
      code: 'DUPLICATE_ID',
    });
    expect(store.getSnapshot().revision).toBe(revision);
  });
  it('holds out-of-order dependencies and drains them when ready', () => {
    const { store, generated, addSection, addNode } = setup();
    const edge = { op: 'edge.add', id: 'g_e', section: 'g_s', from: 'g_a', to: 'g_b' };
    const meta = generated(0);
    expect(store.dispatch(edge, meta).status).toBe('pending');
    expect(store.dispatch(edge, meta).status).toBe('pending');
    expect(store.getPendingCount()).toBe(1);
    addSection();
    addNode('g_a');
    addNode('g_b');
    expect(store.getPendingCount()).toBe(0);
    expect(store.getSnapshot().edges.g_e).toBeDefined();
    expect(store.dispatch(edge, meta).status).toBe('duplicate');
  });
  it('bounds pending operations and reports unresolved/cyclic dependencies at request end', () => {
    const { store, generated } = setup();
    for (let i = 0; i < 200; i++)
      expect(
        store.dispatch({ op: 'node.update', id: `g_${i}`, set: { color: 'red' } }, generated(0))
          .status,
      ).toBe('pending');
    expect(
      store.dispatch({ op: 'node.update', id: 'g_more', set: { color: 'red' } }, generated(0)),
    ).toMatchObject({ code: 'PENDING_LIMIT' });
    expect(store.finishRequest('r1')).toHaveLength(200);
    expect(store.getPendingCount()).toBe(0);
    expect(
      store.dispatch({ op: 'section.add', id: 'g_s', title: 'Late' }, generated()),
    ).toMatchObject({ code: 'REQUEST_ENDED' });
  });
  it('counts all commands in a pending transaction against the pending bound', () => {
    const { store, generated } = setup();
    const commands = Array.from({ length: 150 }, (_, i) => ({
      op: 'node.update',
      id: `g_${i}`,
      set: { color: 'red' },
    }));
    expect(store.dispatchTransaction(commands, generated()).status).toBe('pending');
    expect(store.dispatchTransaction(commands, generated())).toMatchObject({
      code: 'PENDING_LIMIT',
    });
  });
  it('rejects tombstoned dependencies immediately and never reuses deleted IDs', () => {
    const { store, generated, addSection, addNode } = setup();
    addSection();
    addNode('g_a');
    addNode('g_b');
    store.dispatch({ op: 'entity.delete', id: 'g_a' }, generated());
    expect(
      store.dispatch(
        { op: 'edge.add', id: 'g_e', section: 'g_missing', from: 'g_missing', to: 'g_a' },
        generated(),
      ),
    ).toMatchObject({ code: 'TOMBSTONED' });
    expect(addNode('g_a')).toMatchObject({ code: 'TOMBSTONED' });
    expect(
      store.dispatch({ op: 'node.update', id: 'g_a', set: { color: 'red' } }, generated()),
    ).toMatchObject({ code: 'TOMBSTONED' });
  });
  it('preserves manual edits against stale generation and protects active/locked/manual entities', () => {
    const { store, generated, manual, addSection, addNode } = setup();
    addSection();
    addNode();
    const stale = generated();
    store.dispatch({ op: 'node.update', id: 'g_n', set: { label: 'Manual label' } }, manual());
    expect(
      store.dispatch({ op: 'node.update', id: 'g_n', set: { label: 'Stale label' } }, stale),
    ).toMatchObject({ code: 'STALE_MANUAL_EDIT' });
    expect(store.getSnapshot().nodes.g_n!.label).toBe('Manual label');
    store.setEditingIds(['g_n']);
    expect(store.dispatch({ op: 'entity.delete', id: 'g_n' }, generated())).toMatchObject({
      code: 'ACTIVE_EDIT',
    });
    store.setEditingIds([]);
    store.dispatch({ op: 'entity.lock', id: 'g_n', locked: true }, manual());
    expect(
      store.dispatch({ op: 'node.update', id: 'g_n', set: { color: 'red' } }, generated()),
    ).toMatchObject({ code: 'LOCKED' });
    expect(store.dispatch({ op: 'entity.delete', id: 'g_n' }, manual())).toMatchObject({
      code: 'LOCKED',
    });
    expect(store.dispatch({ op: 'entity.lock', id: 'g_n', locked: false }, manual()).status).toBe(
      'applied',
    );
    expect(
      store.dispatch(
        { op: 'node.add', id: manualNodeId, section: 'g_s', type: 'text', label: '' },
        manual(),
      ).status,
    ).toBe('applied');
    expect(store.dispatch({ op: 'entity.delete', id: manualNodeId }, generated())).toMatchObject({
      code: 'PROTECTED',
    });
    expect(
      store.dispatch(
        { op: 'edge.add', id: 'g_manual_link', section: 'g_s', from: 'g_n', to: manualNodeId },
        generated(),
      ).status,
    ).toBe('applied');
  });
  it('protects incident edges before deleting and rolls back failed transactions', () => {
    const { store, generated, manual, addSection, addNode } = setup();
    addSection();
    addNode('g_a');
    addNode('g_b');
    store.dispatch(
      { op: 'edge.add', id: 'g_e', section: 'g_s', from: 'g_a', to: 'g_b' },
      generated(),
    );
    store.dispatch({ op: 'entity.lock', id: 'g_e', locked: true }, manual());
    const before = store.getSnapshot();
    expect(store.dispatch({ op: 'entity.delete', id: 'g_a' }, generated())).toMatchObject({
      code: 'LOCKED',
    });
    expect(store.getSnapshot()).toBe(before);
    expect(
      store.dispatchTransaction(
        [
          { op: 'section.add', id: 'g_new', title: 'New' },
          { op: 'edge.add', id: 'g_bad', section: 'g_s', from: 'g_a', to: 'g_a' },
        ],
        generated(),
      ),
    ).toMatchObject({ code: 'INVALID_REFERENCE' });
    expect(store.getSnapshot()).toBe(before);
  });
  it('rejects cross-section edges and anchors', () => {
    const { store, generated, addSection, addNode } = setup();
    addSection();
    addSection('g_s2');
    addNode('g_a');
    addNode('g_b', 'g_s2');
    expect(
      store.dispatch(
        { op: 'edge.add', id: 'g_e', section: 'g_s', from: 'g_a', to: 'g_b' },
        generated(),
      ),
    ).toMatchObject({ code: 'INVALID_REFERENCE' });
    expect(
      store.dispatch(
        {
          op: 'node.add',
          id: 'g_c',
          section: 'g_s',
          type: 'rect',
          label: 'C',
          place: { below: 'g_b' },
        },
        generated(),
      ),
    ).toMatchObject({ code: 'INVALID_REFERENCE' });
  });
  it('respects manual placement and fixed dimensions, auto-sizes changed labels', () => {
    const { store, generated, manual, addSection, addNode } = setup();
    addSection();
    addNode();
    store.dispatch(
      {
        op: 'node.update',
        id: 'g_n',
        set: { label: 'A significantly longer label', at: [120, -40] },
      },
      manual(),
    );
    expect(store.getSnapshot().nodes.g_n).toMatchObject({ x: 120, y: -40, width: 248 });
    store.dispatch({ op: 'node.resize', id: 'g_n', width: 200, height: 100 }, manual());
    store.dispatch({ op: 'node.update', id: 'g_n', set: { label: 'Short' } }, generated());
    expect(store.getSnapshot().nodes.g_n).toMatchObject({
      width: 200,
      height: 100,
      sizing: 'fixed',
    });
  });
  it('enforces configurable capacities, ID namespaces and transaction IDs', () => {
    const { store, generated, manual, addSection, addNode } = setup({
      limits: { maxEntities: 1, maxSections: 1 },
    });
    addSection();
    addNode();
    expect(addNode('g_second')).toMatchObject({ code: 'LIMIT' });
    expect(addSection('g_s2')).toMatchObject({ code: 'LIMIT' });
    expect(
      store.dispatch({ op: 'section.add', id: 'g_manual_bad', title: 'Bad' }, manual()),
    ).toMatchObject({ code: 'VALIDATION' });
    const meta = generated();
    store.dispatch({ op: 'node.update', id: 'g_n', set: { color: 'blue' } }, meta);
    expect(
      store.dispatch(
        { op: 'node.update', id: 'g_n', set: { color: 'green' } },
        { ...meta, sequence: meta.sequence! + 1 },
      ),
    ).toMatchObject({ code: 'TRANSACTION_REUSE' });
  });
  it('invalidates epochs on reset/cancel and rejects future revisions', () => {
    const invalidated = vi.fn();
    const { store, generated, addSection } = setup({ onSessionInvalidated: invalidated });
    const old = generated();
    addSection();
    store.cancelGeneration();
    expect(store.dispatch({ op: 'section.add', id: 'g_late', title: 'Late' }, old)).toMatchObject({
      code: 'STALE_EPOCH',
    });
    expect(store.getSnapshot().sections.g_s).toBeDefined();
    expect(invalidated).toHaveBeenCalledWith(1);
    expect(
      store.dispatch({ op: 'section.add', id: 'g_future', title: 'Future' }, generated(100)),
    ).toMatchObject({ code: 'FUTURE_REVISION' });
    store.reset();
    expect(store.getSnapshot().revision).toBe(0);
    expect(store.getSessionEpoch()).toBe(2);
  });
  it('import failure preserves state; successful import validates, cancels work and clears history', () => {
    const invalidated = vi.fn();
    const { store, manual, addSection } = setup({ onSessionInvalidated: invalidated });
    addSection();
    store.dispatch({ op: 'section.rename', id: 'g_s', title: 'Renamed' }, manual());
    const before = store.getSnapshot();
    const exported = store.exportScene();
    expect(store.importScene('{bad')).toMatchObject({ code: 'IMPORT' });
    expect(store.getSnapshot()).toBe(before);
    expect(store.importScene(JSON.stringify({ ...before, schemaVersion: 2 }))).toMatchObject({
      code: 'IMPORT',
    });
    expect(store.getSnapshot()).toBe(before);
    expect(store.importScene(exported).status).toBe('applied');
    expect(store.getSnapshot()).toEqual(before);
    expect(store.getHistoryState().undoCount).toBe(0);
    expect(invalidated).toHaveBeenCalledOnce();
  });
  it('isolates subscriber errors and blocks reentrant document writes', () => {
    const { store, generated, addSection } = setup();
    const result: unknown[] = [];
    store.subscribe(() => {
      throw new Error('subscriber');
    });
    store.subscribe(() => {
      result.push(
        store.dispatch({ op: 'section.add', id: 'g_nested', title: 'Nested' }, generated()),
      );
    });
    expect(addSection().status).toBe('applied');
    expect(result[0]).toMatchObject({ code: 'REENTRANT' });
    expect(store.getDiagnostics().at(-1)).toMatchObject({ code: 'CALLBACK' });
  });
  it('rejects layout resizing of unrelated nodes atomically', () => {
    let breakLayout = false;
    const layout: SceneLayout = {
      layoutTransaction(input) {
        const result = testLayout.layoutTransaction(input);
        if (breakLayout) result.nodes.g_n = { x: 999, y: 0, width: 81, height: 48 };
        return result;
      },
    };
    const { store, addSection, addNode } = setup({ layout });
    addSection();
    addNode();
    const before = store.getSnapshot();
    breakLayout = true;
    expect(addNode('g_other')).toMatchObject({ code: 'LAYOUT' });
    expect(store.getSnapshot()).toBe(before);
  });
  it('accepts manual section creation and rejects operations after disposal', () => {
    const { store, manual, generated } = setup();
    expect(
      store.dispatch({ op: 'section.add', id: manualSectionId, title: 'Manual section' }, manual())
        .status,
    ).toBe('applied');
    store.dispose();
    expect(
      store.dispatch({ op: 'section.add', id: 'g_s', title: 'Late' }, generated()),
    ).toMatchObject({ code: 'DISPOSED' });
  });
});

describe('revision-safe manual history', () => {
  it('undoes one field without erasing newer generated content or other fields', () => {
    const { store, manual, generated, addSection, addNode } = setup();
    addSection();
    addNode();
    store.dispatch({ op: 'node.update', id: 'g_n', set: { label: 'Manual label' } }, manual());
    store.dispatch({ op: 'node.update', id: 'g_n', set: { color: 'blue' } }, generated());
    addNode('g_later');
    expect(store.undo().status).toBe('applied');
    expect(store.getSnapshot().nodes.g_n).toMatchObject({ label: 'g_n', color: 'blue' });
    expect(store.getSnapshot().nodes.g_later).toBeDefined();
    expect(store.redo().status).toBe('applied');
    expect(store.getSnapshot().nodes.g_n!.label).toBe('Manual label');
  });
  it('detects ABA field edits and skips a conflicting transaction', () => {
    const { store, manual, generated, addSection, addNode } = setup();
    addSection();
    addNode();
    store.dispatch({ op: 'node.update', id: 'g_n', set: { color: 'blue' } }, manual());
    store.dispatch({ op: 'node.update', id: 'g_n', set: { color: 'green' } }, generated());
    store.dispatch({ op: 'node.update', id: 'g_n', set: { color: 'blue' } }, generated());
    expect(store.undo()).toMatchObject({ code: 'HISTORY_CONFLICT' });
    expect(store.getSnapshot().nodes.g_n!.color).toBe('blue');
    expect(store.undo()).toMatchObject({ code: 'EMPTY_HISTORY' });
  });
  it('restores deleted nodes with incident edges and supports redo without losing unrelated content', () => {
    const { store, generated, manual, addSection, addNode } = setup();
    addSection();
    addNode('g_a');
    addNode('g_b');
    store.dispatch(
      { op: 'edge.add', id: 'g_e', section: 'g_s', from: 'g_a', to: 'g_b' },
      generated(),
    );
    store.dispatch({ op: 'entity.delete', id: 'g_a' }, manual());
    expect(store.getSnapshot().edges.g_e).toBeUndefined();
    addNode('g_later');
    expect(store.undo().status).toBe('applied');
    expect(store.getSnapshot().edges.g_e).toBeDefined();
    expect(store.getSnapshot().nodes.g_later).toBeDefined();
    expect(store.redo().status).toBe('applied');
    expect(store.getSnapshot().nodes.g_a).toBeUndefined();
    expect(store.getSnapshot().edges.g_e).toBeUndefined();
    expect(store.undo().status).toBe('applied');
  });
  it('groups multi-node movement and bounds history to 100 transactions', () => {
    const { store, manual, addSection, addNode } = setup();
    addSection();
    addNode('g_a');
    addNode('g_b');
    store.dispatchTransaction(
      [
        { op: 'node.update', id: 'g_a', set: { at: [10, 20] } },
        { op: 'node.update', id: 'g_b', set: { at: [30, 40] } },
      ],
      manual(),
    );
    expect(store.getHistoryState().undoCount).toBe(1);
    store.undo();
    expect(store.getSnapshot().nodes.g_b!.x).toBe(0);
    for (let i = 0; i < 110; i++)
      store.dispatch({ op: 'node.update', id: 'g_a', set: { at: [i + 1, 0] } }, manual());
    expect(store.getHistoryState()).toEqual({ undoCount: 100, redoCount: 0 });
  });
  it('supports consecutive undo/redo for edits to the same field', () => {
    const { store, manual, addSection, addNode } = setup();
    addSection();
    addNode();
    store.dispatch({ op: 'node.update', id: 'g_n', set: { at: [10, 0] } }, manual());
    store.dispatch({ op: 'node.update', id: 'g_n', set: { at: [20, 0] } }, manual());
    expect(store.undo().status).toBe('applied');
    expect(store.undo().status).toBe('applied');
    expect(store.getSnapshot().nodes.g_n!.x).toBe(0);
    expect(store.redo().status).toBe('applied');
    expect(store.redo().status).toBe('applied');
    expect(store.getSnapshot().nodes.g_n!.x).toBe(20);
  });
  it('does not undo an added node if newer generated edges require it', () => {
    const { store, manual, generated, addSection, addNode } = setup();
    addSection();
    addNode();
    store.dispatch(
      { op: 'node.add', id: manualNodeId, section: 'g_s', type: 'rect', label: 'Manual' },
      manual(),
    );
    store.dispatch(
      { op: 'edge.add', id: 'g_e', section: 'g_s', from: 'g_n', to: manualNodeId },
      generated(),
    );
    expect(store.undo()).toMatchObject({ code: 'HISTORY_CONFLICT' });
    expect(store.getSnapshot().nodes[manualNodeId]).toBeDefined();
    expect(store.getSnapshot().edges.g_e).toBeDefined();
  });
  it('can undo an insertion after undoing later label and movement edits', () => {
    const { store, manual, addSection } = setup();
    addSection();
    store.dispatch(
      { op: 'node.add', id: manualNodeId, section: 'g_s', type: 'rect', label: 'Manual' },
      manual(),
    );
    store.dispatch(
      {
        op: 'node.update',
        id: manualNodeId,
        set: { label: 'A longer manual label', at: [80, 20] },
      },
      manual(),
    );
    expect(store.undo().status).toBe('applied');
    expect(store.undo().status).toBe('applied');
    expect(store.getSnapshot().nodes[manualNodeId]).toBeUndefined();
    expect(store.redo().status).toBe('applied');
    expect(store.redo().status).toBe('applied');
    expect(store.getSnapshot().nodes[manualNodeId]).toMatchObject({
      label: 'A longer manual label',
      x: 80,
      y: 20,
    });
  });
  it('undo/redo resize preserves newer label changes and recomputes auto sizing', () => {
    const { store, generated, manual, addSection, addNode } = setup();
    addSection();
    addNode();
    store.dispatch({ op: 'node.resize', id: 'g_n', width: 160, height: 80 }, manual());
    store.dispatch(
      { op: 'node.update', id: 'g_n', set: { label: 'A much longer generated label' } },
      generated(),
    );
    expect(store.undo().status).toBe('applied');
    expect(store.getSnapshot().nodes.g_n).toMatchObject({
      sizing: 'auto',
      label: 'A much longer generated label',
    });
    expect(store.redo().status).toBe('applied');
    expect(store.getSnapshot().nodes.g_n).toMatchObject({
      sizing: 'fixed',
      width: 160,
      height: 80,
      label: 'A much longer generated label',
    });
  });
  it('keeps protected entities protected during history and clears redo on new manual work', () => {
    const { store, generated, manual, addSection, addNode } = setup();
    addSection();
    addNode();
    store.dispatch({ op: 'node.update', id: 'g_n', set: { color: 'blue' } }, manual());
    store.setEditingIds(['g_n']);
    expect(store.undo()).toMatchObject({ code: 'HISTORY_CONFLICT' });
    store.setEditingIds([]);
    store.dispatch({ op: 'entity.lock', id: 'g_n', locked: true }, manual());
    expect(store.undo().status).toBe('applied');
    expect(store.getSnapshot().nodes.g_n!.locked).toBe(false);
    store.dispatch({ op: 'node.update', id: 'g_n', set: { color: 'red' } }, manual());
    expect(store.getHistoryState().redoCount).toBe(0);
    expect(
      store.dispatch({ op: 'node.update', id: 'g_n', set: { color: 'purple' } }, generated(0)),
    ).toMatchObject({ code: 'STALE_MANUAL_EDIT' });
  });
  it('retains ID tombstones across reset and never mutates prototype functions', () => {
    const { store, generated, addSection, addNode } = setup();
    addSection();
    addNode();
    store.reset();
    expect(addSection()).toMatchObject({ code: 'TOMBSTONED' });
    expect(
      store.dispatch(
        { op: 'node.update', id: 'toString', set: { label: 'polluted' } },
        generated(),
      ),
    ).toMatchObject({ code: 'VALIDATION' });
    expect(Object.hasOwn(Object.prototype.toString, 'label')).toBe(false);
  });
});
