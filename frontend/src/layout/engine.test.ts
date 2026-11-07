import { describe, expect, it, vi } from 'vitest';
import { sceneSchema } from '../contracts';
import { setup, manualNodeId } from '../scene/test-helpers';
import { createLayoutEngine, layoutTransaction } from './engine';
import { routeEdge } from './edges';
import { boxesOverlap } from './placement';
import { getSectionBounds, getSectionHeader } from './sections';
import { fixedMeasurer, node, scene, section } from './test-fixtures';
import { worldToScreen } from './transforms';

function layoutSetup() {
  const engine = createLayoutEngine({ measurer: fixedMeasurer });
  return { ...setup({ layout: engine }), engine };
}
describe('production scene-layout integration', () => {
  it('rejects impossible protected routing atomically without moving locked obstacles', () => {
    const initialScene = scene([
      node({ locked: true }),
      node({ id: 'g_b', x: 600, locked: true }),
      node({ id: 'g_cover', x: -100, y: -100, width: 400, height: 300, locked: true }),
    ]);
    const { store, generated } = setup({
      initialScene,
      layout: createLayoutEngine({ measurer: fixedMeasurer }),
    });
    const before = store.getSnapshot();
    const result = store.dispatch(
      { op: 'edge.add', id: 'g_e', section: 'g_s', from: 'g_a', to: 'g_b' },
      generated(),
    );
    expect(result).toMatchObject({ status: 'rejected', code: 'LAYOUT' });
    expect(store.getSnapshot()).toBe(before);
  });

  it('preserves manually positioned nodes and untouched sections during generated repairs', () => {
    const { store, generated, manual, addSection, addNode } = layoutSetup();
    addSection();
    addNode();
    addNode('g_b');
    store.dispatch({ op: 'node.update', id: 'g_n', set: { at: [200, 100] } }, manual());
    addSection('g_other');
    addNode('g_othernode', 'g_other');
    const protectedNode = store.getSnapshot().nodes.g_n;
    const unrelated = store.getSnapshot().nodes.g_othernode;
    expect(
      store.dispatch({ op: 'node.update', id: 'g_b', set: { at: [200, 100] } }, generated()).status,
    ).toBe('applied');
    expect(store.getSnapshot().nodes.g_n).toBe(protectedNode);
    expect(store.getSnapshot().nodes.g_othernode).toBe(unrelated);
    expect(boxesOverlap(store.getSnapshot().nodes.g_b!, protectedNode!, 16)).toBe(false);
  });
  it('wraps long generated rows while preserving established nodes', () => {
    const { store, generated, addSection, addNode } = layoutSetup();
    addSection();
    addNode();
    const first = store.getSnapshot().nodes.g_n!;
    let anchor = 'g_n';
    for (let i = 0; i < 9; i++) {
      const id = `g_wrap${i}`;
      expect(
        store.dispatchTransaction(
          [
            {
              op: 'node.add',
              id,
              section: 'g_s',
              type: 'rect',
              label: 'Component',
              place: { rightOf: anchor },
            },
          ],
          generated(),
        ).status,
      ).toBe('applied');
      anchor = id;
    }
    const nodes = Object.values(store.getSnapshot().nodes);
    expect(nodes.some((n) => n.y > first.y)).toBe(true);
    expect(nodes.every((n) => n.x + n.width <= 1000)).toBe(true);
    expect(store.getSnapshot().nodes.g_n).toBe(first);
  });
  it('lays out a branching fixture transaction and preserves previous geometry', () => {
    const { store, generated, addSection, addNode } = layoutSetup();
    addSection();
    addNode();
    const old = store.getSnapshot().nodes.g_n;
    expect(
      store.dispatchTransaction(
        [
          {
            op: 'node.add',
            id: 'g_b',
            section: 'g_s',
            type: 'roundRect',
            label: 'Server',
            place: { rightOf: 'g_n' },
          },
          {
            op: 'node.add',
            id: 'g_c',
            section: 'g_s',
            type: 'diamond',
            label: 'Cache?',
            place: { below: 'g_b' },
          },
          { op: 'edge.add', id: 'g_e', section: 'g_s', from: 'g_n', to: 'g_b' },
        ],
        generated(),
      ).status,
    ).toBe('applied');
    expect(store.getSnapshot().nodes.g_n).toBe(old);
    expect(store.getSnapshot().nodes.g_b!.x).toBe(old!.width + 64);
    expect(store.getSnapshot().nodes.g_c!.y).toBe(store.getSnapshot().nodes.g_b!.height + 64);
    expect(sceneSchema.safeParse(store.getSnapshot()).success).toBe(true);
  });
  it('corrects generated collisions against manually moved/resized nodes', () => {
    const { store, generated, manual, addSection } = layoutSetup();
    addSection();
    store.dispatch(
      {
        op: 'node.add',
        id: manualNodeId,
        section: 'g_s',
        type: 'rect',
        label: 'Database',
        at: [200, 100],
      },
      manual(),
    );
    store.dispatch(
      { op: 'node.resize', id: manualNodeId, width: 400, height: 180, at: [100, 50] },
      manual(),
    );
    const manualNode = store.getSnapshot().nodes[manualNodeId]!;
    expect(
      store.dispatch(
        {
          op: 'node.add',
          id: 'g_new',
          section: 'g_s',
          type: 'rect',
          label: 'Generated',
          at: [100, 50],
        },
        generated(),
      ).status,
    ).toBe('applied');
    expect(boxesOverlap(store.getSnapshot().nodes.g_new!, manualNode)).toBe(false);
    expect(store.getSnapshot().nodes[manualNodeId]).toBe(manualNode);
  });
  it('honors manual overlap and a later explicit move inside the insertion transaction', () => {
    const { store, manual, addSection, addNode } = layoutSetup();
    addSection();
    addNode();
    expect(
      store.dispatchTransaction(
        [
          {
            op: 'node.add',
            id: manualNodeId,
            section: 'g_s',
            type: 'rect',
            label: 'Manual',
            at: [999, 999],
          },
          { op: 'node.update', id: manualNodeId, set: { at: [0, 0] } },
        ],
        manual(),
      ).status,
    ).toBe('applied');
    expect(store.getSnapshot().nodes[manualNodeId]).toMatchObject({ x: 0, y: 0 });
    expect(
      boxesOverlap(store.getSnapshot().nodes.g_n!, store.getSnapshot().nodes[manualNodeId]!),
    ).toBe(true);
  });
  it('repairs label growth without moving an unaffected neighbor', () => {
    const { store, generated, addSection, addNode } = layoutSetup();
    addSection();
    addNode();
    store.dispatch(
      { op: 'node.add', id: 'g_b', section: 'g_s', type: 'rect', label: 'Neighbor', at: [184, 0] },
      generated(),
    );
    const old = store.getSnapshot().nodes.g_b;
    const result = store.dispatch(
      {
        op: 'node.update',
        id: 'g_n',
        set: { label: 'A long generated label which will expand into the neighboring node' },
      },
      generated(),
    );
    expect(result.status).toBe('applied');
    expect(store.getSnapshot().nodes.g_b).toBe(old);
    expect(boxesOverlap(store.getSnapshot().nodes.g_n!, old!, 16)).toBe(false);
    expect(store.getDiagnostics().some((d) => d.message.includes('Collision repaired'))).toBe(true);
  });
  it('keeps fixed sizes on label changes and remeasures undo/redo through the real adapter', () => {
    const { store, generated, manual, addSection, addNode } = layoutSetup();
    addSection();
    addNode();
    store.dispatch({ op: 'node.resize', id: 'g_n', width: 240, height: 120 }, manual());
    store.dispatch(
      { op: 'node.update', id: 'g_n', set: { label: 'New generated content' } },
      generated(),
    );
    expect(store.getSnapshot().nodes.g_n).toMatchObject({
      sizing: 'fixed',
      width: 240,
      height: 120,
    });
    expect(store.undo().status).toBe('applied');
    expect(store.getSnapshot().nodes.g_n!.sizing).toBe('auto');
    expect(store.redo().status).toBe('applied');
    expect(store.getSnapshot().nodes.g_n).toMatchObject({
      sizing: 'fixed',
      width: 240,
      height: 120,
      label: 'New generated content',
    });
  });
  it('holds relative anchors until available and terminates cyclic dependencies at request end', () => {
    const { store, generated, addSection, addNode } = layoutSetup();
    addSection();
    const add = (id: string, rightOf: string) =>
      store.dispatch(
        { op: 'node.add', id, section: 'g_s', type: 'rect', label: id, place: { rightOf } },
        generated(),
      );
    expect(add('g_b', 'g_n').status).toBe('pending');
    addNode();
    expect(store.getSnapshot().nodes.g_b!.x).toBe(store.getSnapshot().nodes.g_n!.width + 64);
    expect(add('g_c', 'g_d').status).toBe('pending');
    expect(add('g_d', 'g_c').status).toBe('pending');
    expect(store.finishRequest('r1')).toHaveLength(2);
    expect(store.getPendingCount()).toBe(0);
  });
  it('diagnoses bounded append fallback through the dispatcher', () => {
    const { store, addSection, addNode } = setup({
      layout: createLayoutEngine({ measurer: fixedMeasurer, maxPlacementCandidates: 1 }),
    });
    addSection();
    addNode();
    expect(addNode('g_b').status).toBe('applied');
    expect(store.getDiagnostics().some((d) => d.message.includes('exhausted 1'))).toBe(true);
  });
  it('grows earlier sections without overlap and compensates the chosen viewport anchor', () => {
    const onLayout = vi.fn();
    const engine = createLayoutEngine({ measurer: fixedMeasurer });
    const { store, generated, addSection, addNode } = setup({ layout: engine, onLayout });
    addSection();
    addNode();
    addSection('g_s2');
    addNode('g_second', 'g_s2');
    engine.setAnchorSection('g_s2');
    const before = store.getSnapshot();
    const origin = before.sections.g_s2!.origin;
    const viewport = { x: 0, y: -origin.y + 100, scale: 1 };
    const screenBefore = worldToScreen(origin, viewport);
    expect(
      store.dispatch(
        { op: 'node.update', id: 'g_n', set: { label: 'Line\n'.repeat(20) } },
        generated(),
      ).status,
    ).toBe('applied');
    const after = store.getSnapshot();
    const delta = onLayout.mock.calls.at(-1)![0].anchorDelta;
    expect(delta.y).toBeGreaterThan(0);
    expect(after.nodes.g_second).toBe(before.nodes.g_second);
    const earlierBottom =
      after.sections.g_s!.origin.y +
      after.sections.g_s!.bounds.y +
      after.sections.g_s!.bounds.height;
    expect(
      after.sections.g_s2!.origin.y + after.sections.g_s2!.bounds.y - earlierBottom,
    ).toBeCloseTo(160);
    expect(
      worldToScreen(after.sections.g_s2!.origin, { ...viewport, y: viewport.y - delta.y }),
    ).toEqual(screenBefore);
    const stableOrigin = after.sections.g_s2!.origin;
    store.dispatch({ op: 'node.update', id: 'g_n', set: { label: 'Short' } }, generated());
    expect(store.getSnapshot().sections.g_s2!.origin).toEqual(stableOrigin);
  });
  it('includes negative content, section headers and padding in local bounds', () => {
    const content = node({ x: -200, y: -120, width: 300, height: 140 });
    const s = section({
      title: 'A section title that remains readable and can wrap on long headings',
    });
    const bounds = getSectionBounds(s, [content], { measurer: fixedMeasurer });
    expect(bounds.x).toBe(-232);
    expect(bounds.y).toBeLessThan(-152);
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(content.x + content.width + 32);
    expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(content.y + content.height + 32);
    const title = getSectionHeader({ ...s, bounds }, { measurer: fixedMeasurer });
    expect(title.y + title.height).toBeLessThan(content.y);
    expect(title.truncated).toBe(false);
  });
  it('appends with exactly 160 units of clearance even on imported negative origins', () => {
    const engine = createLayoutEngine({ measurer: fixedMeasurer });
    const initialScene = scene([node()], [section({ origin: { x: 0, y: -2_000 } })]);
    const { store, addSection } = setup({ layout: engine, initialScene });
    expect(addSection('g_second').status).toBe('applied');
    const first = store.getSnapshot().sections.g_s!;
    const second = store.getSnapshot().sections.g_second!;
    expect(second.origin.y).toBeLessThan(0);
    expect(
      second.origin.y + second.bounds.y - first.origin.y - first.bounds.y - first.bounds.height,
    ).toBeCloseTo(160);
  });
  it('is pure, deterministic and does not write UI anchor state into the scene', () => {
    const board = scene();
    const previous = structuredClone(board);
    const input = {
      previousScene: board,
      scene: board,
      commands: [],
      meta: { source: 'manual' as const, sessionEpoch: 0, transactionId: 'test' },
      measureNodeIds: ['g_a'],
      addedNodeIds: [],
    };
    const a = layoutTransaction(input, { measurer: fixedMeasurer });
    const b = layoutTransaction(input, { measurer: fixedMeasurer });
    expect(a).toEqual(b);
    expect(board).toEqual(previous);
    expect(Object.keys(a.nodes)).toEqual(['g_a']);
  });
  it('includes edge label backgrounds in section content bounds', () => {
    const { store, generated, manual, addSection } = layoutSetup();
    addSection();
    const manualSecondId = 'm_00000000-0000-4000-8000-000000000003';
    for (const [id, x] of [
      [manualNodeId, 0],
      [manualSecondId, 40],
    ] as const) {
      store.dispatch(
        { op: 'node.add', id, section: 'g_s', type: 'text', label: 'A', at: [x, 0] },
        manual(),
      );
    }
    expect(
      store.dispatch(
        {
          op: 'edge.add',
          id: 'g_edge',
          section: 'g_s',
          from: manualNodeId,
          to: manualSecondId,
          label: 'A wide connector label across nearby nodes',
        },
        generated(),
      ).status,
    ).toBe('applied');
    const snapshot = store.getSnapshot();
    const label = routeEdge(snapshot.edges.g_edge!, snapshot, { measurer: fixedMeasurer })!.label!;
    expect(snapshot.sections.g_s!.bounds.x).toBeLessThanOrEqual(
      label.box.x - snapshot.sections.g_s!.origin.x - 32,
    );
    expect(snapshot.sections.g_s!.bounds.y).toBeLessThan(
      label.box.y - snapshot.sections.g_s!.origin.y,
    );
  });
  it('rejects unrepresentable section padding atomically near the coordinate boundary', () => {
    const { store, generated, addSection, addNode } = layoutSetup();
    addSection();
    addNode();
    const before = store.getSnapshot();
    expect(
      store.dispatch(
        { op: 'node.update', id: 'g_n', set: { at: [-100_000, -100_000] } },
        generated(),
      ),
    ).toMatchObject({ status: 'rejected', code: 'LAYOUT' });
    expect(store.getSnapshot()).toBe(before);
  });
});
