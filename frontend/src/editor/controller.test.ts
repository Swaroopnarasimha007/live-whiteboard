import { describe, expect, it, vi } from 'vitest';
import { sceneSchema, shapeSchema } from '../contracts';
import { createLayoutEngine, worldToScreen } from '../layout';
import { fixedMeasurer } from '../layout/test-fixtures';
import { setup } from '../scene/test-helpers';
import { ViewportController } from '../board/viewport';
import { createEditorController } from './controller';
import { handleEditorKeyDown } from './shortcuts';

function editorSetup() {
  const base = setup({ layout: createLayoutEngine({ measurer: fixedMeasurer }) });
  const viewport = new ViewportController({ reducedMotion: true });
  let uuid = 1_000;
  const editor = createEditorController(base.store, viewport, {
    uuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
  });
  return { ...base, viewport, editor };
}
describe('manual editor command controller', () => {
  it.each(shapeSchema.options)(
    'inserts %s with a manual section in one validated transaction',
    (type) => {
      const { editor, store } = editorSetup();
      expect(editor.insert(type, { x: 140, y: 80 }).status).toBe('applied');
      const scene = store.getSnapshot();
      const node = Object.values(scene.nodes)[0]!;
      expect(Object.keys(scene.sections)).toHaveLength(1);
      expect(node).toMatchObject({ x: 140, y: 80, source: 'manual', lastManualRevision: 1 });
      expect(node.id).toMatch(/^m_/);
      expect(scene.revision).toBe(1);
      expect(sceneSchema.safeParse(scene).success).toBe(true);
      expect(store.getHistoryState().undoCount).toBe(1);
      expect(editor.getSnapshot().tool).toBe('select');
      expect(editor.getSnapshot().interactionInProgress).toBe(type === 'text');
    },
  );
  it('inserts under the pointer or selected section, independently of the current live topic', () => {
    const { editor, viewport, store, addSection } = editorSetup();
    addSection();
    addSection('g_s2');
    viewport.observeScene(store.getSnapshot());
    editor.setActiveSection('g_s');
    expect(viewport.getSnapshot().liveSectionId).toBe('g_s2');
    editor.insert('rect', { x: 1_500, y: -500 });
    expect(Object.values(store.getSnapshot().nodes)[0]!.sectionId).toBe('g_s');
    const section = store.getSnapshot().sections.g_s2!;
    editor.insert('circle', { x: section.origin.x + 10, y: section.origin.y + 10 });
    expect(Object.values(store.getSnapshot().nodes).at(-1)!.sectionId).toBe('g_s2');
  });
  it.each([0.5, 2])('uses inverse viewport coordinates on insertion at %s zoom', (scale) => {
    const { viewport, editor, store } = editorSetup();
    viewport.setViewport({ x: -160, y: 75, scale });
    const screen = { x: 240, y: 190 };
    editor.insert('rect', viewport.screenToWorld(screen));
    const node = Object.values(store.getSnapshot().nodes)[0]!;
    expect(worldToScreen(node, viewport.getViewport())).toEqual(screen);
  });
  it('keeps snapping independent of grid and never mutates the scene on tool/snap changes', () => {
    const { editor, store } = editorSetup();
    const initial = store.getSnapshot();
    editor.setTool('circle');
    editor.setSnap(true);
    expect(store.getSnapshot()).toBe(initial);
    editor.insert('circle', { x: 19, y: 49 });
    expect(Object.values(store.getSnapshot().nodes)[0]).toMatchObject({ x: 32, y: 64 });
    editor.nudge({ x: 1, y: 0 });
    expect(Object.values(store.getSnapshot().nodes)[0]!.x).toBe(64);
  });
  it('inserts over an existing shape while an insertion tool is armed', () => {
    const { editor, store, addSection, addNode } = editorSetup();
    addSection();
    addNode();
    editor.setTool('diamond');
    editor.pointerDown('g_n', { x: 10, y: 10 }, 'g_s');
    const manual = Object.values(store.getSnapshot().nodes).find((n) => n.source === 'manual')!;
    expect(manual).toMatchObject({ x: 10, y: 10, type: 'diamond' });
    expect(store.getSnapshot().nodes.g_n).toBeDefined();
  });
  it('previews multi-node movement and commits once with field-level undo', () => {
    const { editor, store, addSection, addNode, generated } = editorSetup();
    addSection();
    addNode('g_a');
    addNode('g_b');
    editor.select('g_a');
    editor.select('g_b', true);
    const before = store.getSnapshot();
    expect(editor.beginMove('g_a', { x: 0, y: 0 })).toBe(true);
    editor.previewMove({ x: 45, y: -25 });
    expect(store.getSnapshot()).toBe(before);
    expect(editor.getSnapshot().previews.g_a).toMatchObject({ x: 45, y: -25 });
    expect(editor.getSnapshot().interactionInProgress).toBe(true);
    expect(editor.commitGesture()?.status).toBe('applied');
    expect(store.getSnapshot().revision).toBe(before.revision + 1);
    expect(store.getHistoryState().undoCount).toBe(1);
    addNode('g_later');
    expect(editor.undo().status).toBe('applied');
    expect(store.getSnapshot().nodes.g_a!.x).toBe(0);
    expect(store.getSnapshot().nodes.g_later).toBeDefined();
    expect(
      store.dispatch({ op: 'node.update', id: 'g_a', set: { color: 'red' } }, generated(0)),
    ).toMatchObject({ code: 'STALE_MANUAL_EDIT' });
  });
  it('rejects generated updates during a gesture and stale changes after commit', () => {
    const { editor, store, addSection, addNode, generated } = editorSetup();
    addSection();
    addNode();
    editor.select('g_n');
    const base = store.getSnapshot().revision;
    editor.beginMove('g_n', { x: 0, y: 0 });
    expect(
      store.dispatch({ op: 'node.update', id: 'g_n', set: { label: 'Stale' } }, generated(base)),
    ).toMatchObject({ code: 'ACTIVE_EDIT' });
    editor.previewMove({ x: 10, y: 20 });
    editor.commitGesture();
    expect(
      store.dispatch({ op: 'node.update', id: 'g_n', set: { label: 'Stale' } }, generated(base)),
    ).toMatchObject({ code: 'STALE_MANUAL_EDIT' });
  });
  it('cancels gestures without persistent writes and detects external changes', () => {
    const { editor, store, addSection, addNode, manual } = editorSetup();
    addSection();
    addNode();
    editor.select('g_n');
    const before = store.getSnapshot();
    editor.beginMove('g_n', { x: 0, y: 0 });
    editor.previewMove({ x: 30, y: 40 });
    editor.escape();
    expect(store.getSnapshot()).toBe(before);
    expect(editor.getSnapshot().previews).toEqual({});
    editor.beginMove('g_n', { x: 0, y: 0 });
    store.dispatch({ op: 'entity.lock', id: 'g_n', locked: true }, manual());
    expect(editor.getSnapshot().interactionInProgress).toBe(false);
    expect(editor.getSnapshot().message).toContain('cancelled');
  });
  it('respects locked selection and allows explicit unlock', () => {
    const { editor, store, addSection, addNode } = editorSetup();
    addSection();
    addNode();
    editor.select('g_n');
    editor.lockSelection(true);
    const before = store.getSnapshot();
    expect(editor.beginMove('g_n', { x: 0, y: 0 })).toBe(false);
    expect(editor.deleteSelection()).toMatchObject({ status: 'rejected' });
    expect(editor.setSize('g_n', 200, 100)).toMatchObject({ code: 'LOCKED' });
    expect(store.getSnapshot()).toBe(before);
    editor.lockSelection(false);
    expect(editor.beginResize('g_n')).toBe(true);
  });
  it('resizes through previews, preserves circle equality and rejects limits', () => {
    const { editor, store } = editorSetup();
    editor.insert('circle', { x: 40, y: 50 });
    const id = editor.getSnapshot().selectedIds[0]!;
    const before = store.getSnapshot();
    editor.beginResize(id);
    expect(editor.previewResize({ [id]: { x: 35, y: 45, width: 200, height: 200 } })).toBe(true);
    expect(store.getSnapshot()).toBe(before);
    expect(editor.previewResize({ [id]: { x: 35, y: 45, width: 20, height: 20 } })).toBe(false);
    editor.commitGesture();
    expect(store.getSnapshot().nodes[id]).toMatchObject({
      x: 35,
      y: 45,
      width: 200,
      height: 200,
      sizing: 'fixed',
    });
    editor.setSize(id, 48, 100);
    expect(store.getSnapshot().nodes[id]).toMatchObject({ width: 48, height: 48 });
  });
  it('creates arrow/line connections from IDs and rejects self/cross-section links', () => {
    const { editor, store, addSection, addNode } = editorSetup();
    addSection();
    addSection('g_s2');
    addNode('g_a');
    addNode('g_b');
    addNode('g_c', 'g_s2');
    editor.setTool('arrow');
    editor.connect('g_a');
    editor.updatePointer({ x: 100, y: 200 });
    expect(editor.getSnapshot().pointer).toEqual({ x: 100, y: 200 });
    expect(editor.connect('g_a')).toMatchObject({ status: 'rejected' });
    expect(editor.connect('g_c')).toMatchObject({ status: 'rejected' });
    expect(editor.connect('g_b')?.status).toBe('applied');
    expect(Object.values(store.getSnapshot().edges)[0]).toMatchObject({
      from: 'g_a',
      to: 'g_b',
      kind: 'arrow',
      source: 'manual',
    });
    editor.setTool('line');
    editor.connect('g_b');
    editor.connect('g_a');
    expect(Object.values(store.getSnapshot().edges).at(-1)!.kind).toBe('line');
    editor.setTool('arrow');
    editor.connect('g_a');
    editor.escape();
    expect(editor.getSnapshot().connectorFrom).toBeNull();
  });
  it('duplicates selected nodes and internal edges only, remapping IDs in one transaction', () => {
    const { editor, store, addSection, addNode, generated } = editorSetup();
    addSection();
    addNode('g_a');
    addNode('g_b');
    addNode('g_c');
    for (const [id, from, to] of [
      ['g_internal', 'g_a', 'g_b'],
      ['g_external', 'g_b', 'g_c'],
    ])
      store.dispatch({ op: 'edge.add', id, section: 'g_s', from, to }, generated());
    editor.select('g_a');
    editor.select('g_b', true);
    const revision = store.getSnapshot().revision;
    expect(editor.duplicate()?.status).toBe('applied');
    const duplicates = editor.getSnapshot().selectedIds;
    expect(duplicates).toHaveLength(2);
    expect(duplicates.every((id) => id.startsWith('m_'))).toBe(true);
    const edges = Object.values(store.getSnapshot().edges).filter((e) => e.source === 'manual');
    expect(edges).toHaveLength(1);
    expect(duplicates).toContain(edges[0]!.from);
    expect(duplicates).toContain(edges[0]!.to);
    expect(store.getSnapshot().revision).toBe(revision + 1);
    editor.undo();
    expect(Object.keys(store.getSnapshot().nodes)).toHaveLength(3);
    editor.redo();
    expect(Object.keys(store.getSnapshot().nodes)).toHaveLength(5);
  });
  it('deletes a selected node and incident edge without issuing a duplicate cascade delete', () => {
    const { editor, store, addSection, addNode, generated } = editorSetup();
    addSection();
    addNode('g_a');
    addNode('g_b');
    store.dispatch(
      { op: 'edge.add', id: 'g_e', section: 'g_s', from: 'g_a', to: 'g_b' },
      generated(),
    );
    editor.select('g_a');
    editor.select('g_e', true);
    expect(editor.deleteSelection()?.status).toBe('applied');
    expect(store.getSnapshot().edges.g_e).toBeUndefined();
    editor.undo();
    expect(store.getSnapshot().nodes.g_a).toBeDefined();
    expect(store.getSnapshot().edges.g_e).toBeDefined();
  });
  it('protects label drafts, commits once and exposes context deferral', () => {
    const { editor, store, addSection, addNode, generated } = editorSetup();
    addSection();
    addNode();
    const before = store.getSnapshot();
    editor.editLabel('g_n');
    editor.setLabelDraft('Manual label');
    expect(store.getSnapshot()).toBe(before);
    expect(editor.getSnapshot().interactionInProgress).toBe(true);
    expect(
      store.dispatch(
        { op: 'node.update', id: 'g_n', set: { label: 'Generated label' } },
        generated(),
      ),
    ).toMatchObject({ code: 'ACTIVE_EDIT' });
    expect(editor.commitLabel()?.status).toBe('applied');
    expect(store.getSnapshot().nodes.g_n!.label).toBe('Manual label');
    expect(editor.getSnapshot().interactionInProgress).toBe(false);
    editor.editLabel('g_n');
    editor.setLabelDraft('Cancelled label');
    editor.escape();
    expect(store.getSnapshot().nodes.g_n!.label).toBe('Manual label');
  });
  it('undoes an insertion including its newly created manual section', () => {
    const { editor, store } = editorSetup();
    editor.insert('rect', { x: 10, y: 20 });
    expect(editor.undo().status).toBe('applied');
    expect(Object.keys(store.getSnapshot().sections)).toHaveLength(0);
    expect(editor.redo().status).toBe('applied');
    expect(Object.values(store.getSnapshot().nodes)[0]).toMatchObject({ x: 10, y: 20 });
  });
  it('updates colors/section title through commands and cleans listeners/protection on disposal', async () => {
    const { editor, store, addSection, addNode, generated } = editorSetup();
    addSection();
    addNode();
    editor.select('g_n');
    editor.setColor('purple');
    expect(store.getSnapshot().nodes.g_n!.color).toBe('purple');
    editor.renameSection('g_s', 'Renamed');
    expect(store.getSnapshot().sections.g_s!.title).toBe('Renamed');
    editor.editLabel('g_n');
    const listener = vi.fn();
    editor.subscribe(listener);
    editor.dispose();
    await Promise.resolve();
    const calls = listener.mock.calls.length;
    expect(
      store.dispatch(
        { op: 'node.update', id: 'g_n', set: { label: 'After disposal' } },
        generated(),
      ).status,
    ).toBe('applied');
    expect(listener).toHaveBeenCalledTimes(calls);
  });
  it('cancels drafts on same-revision import, preserving them on failure and generation cancellation', () => {
    const { editor, store, addSection, addNode } = editorSetup();
    addSection();
    addNode();
    editor.editLabel('g_n');
    editor.setLabelDraft('Uncommitted');
    store.cancelGeneration();
    expect(editor.getSnapshot().interactionInProgress).toBe(true);
    expect(store.importScene('{invalid').status).toBe('rejected');
    expect(editor.getSnapshot().labelEdit!.text).toBe('Uncommitted');
    expect(store.importScene(store.exportScene()).status).toBe('applied');
    expect(editor.getSnapshot().labelEdit).toBeNull();
    expect(editor.getSnapshot().selectedIds).toEqual([]);
  });
});
describe('editor keyboard actions', () => {
  it('routes shortcuts, preserves IME composition and nudges by keyboard', () => {
    const { editor, store } = editorSetup();
    editor.insert('rect', { x: 10, y: 20 });
    const key = (key: string, patch: object = {}) => ({
      key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      target: null,
      preventDefault: vi.fn(),
      ...patch,
    });
    handleEditorKeyDown(key('ArrowRight', { shiftKey: true }), editor);
    expect(Object.values(store.getSnapshot().nodes)[0]!.x).toBe(20);
    handleEditorKeyDown(key('z', { ctrlKey: true }), editor);
    expect(Object.values(store.getSnapshot().nodes)[0]!.x).toBe(10);
    const composing = key('Delete', { isComposing: true });
    expect(handleEditorKeyDown(composing, editor)).toBe(false);
    expect(composing.preventDefault).not.toHaveBeenCalled();
    handleEditorKeyDown(key('r', { shiftKey: true }), editor);
    expect(editor.getSnapshot().tool).toBe('roundRect');
  });
});
