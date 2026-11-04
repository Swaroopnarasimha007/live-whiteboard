import { describe, expect, it } from 'vitest';
import { createEdgeRouter, getShapeBoundary, routeEdge } from './edges';
import { edge, fixedMeasurer, node, scene, section } from './test-fixtures';

describe('shape-boundary connectors', () => {
  it('routes a return above intervening nodes and invalidates when obstacles move', () => {
    const s = scene([node(), node({ id: 'g_b', x: 600 }), node({ id: 'g_middle', x: 300 })]);
    const e = edge({ from: 'g_b', to: 'g_n', label: 'JSON response' });
    // Use actual fixture endpoint identity.
    e.to = Object.keys(s.nodes)[0]!;
    const router = createEdgeRouter({ measurer: fixedMeasurer });
    const r = router.route(e, s)!;
    expect(r.points.length).toBeGreaterThan(4);
    expect(Math.min(...r.points.filter((_, i) => i % 2 === 1))).toBeLessThan(r.start.y);
    const changed = { ...s, nodes: { ...s.nodes, g_middle: { ...s.nodes.g_middle!, y: -200 } } };
    expect(router.route(e, changed)).not.toBe(r);
  });
  it('offsets labels off short connectors so their backgrounds do not hide arrowheads', () => {
    const result = routeEdge(
      edge({ label: 'Request' }),
      scene([node(), node({ id: 'g_b', x: 184 })]),
      { measurer: fixedMeasurer },
    )!;
    expect(result.label!.box.y + result.label!.box.height).toBeLessThan(result.start.y);
    expect(result.label!.box.x + result.label!.box.width / 2).toBeCloseTo(
      (result.start.x + result.end.x) / 2,
    );
    expect(result.arrowhead).not.toBeNull();
  });
  it.each(['rect', 'text'] as const)('attaches %s to its actual box boundary', (type) => {
    expect(getShapeBoundary(node({ type, width: 100, height: 80 }), { x: 200, y: 40 })).toEqual({
      x: 100,
      y: 40,
    });
    expect(getShapeBoundary(node({ type, width: 100, height: 80 }), { x: 50, y: -100 })).toEqual({
      x: 50,
      y: 0,
    });
  });
  it.each(['ellipse', 'circle'] as const)('solves the %s equation on diagonal rays', (type) => {
    const shape = node({ type, width: 120, height: type === 'circle' ? 120 : 80 });
    const point = getShapeBoundary(shape, { x: 300, y: 300 });
    const dx = (point.x - shape.width / 2) / (shape.width / 2);
    const dy = (point.y - shape.height / 2) / (shape.height / 2);
    expect(dx * dx + dy * dy).toBeCloseTo(1, 10);
  });
  it('solves diamond intersection instead of attaching to its bounding box', () => {
    const point = getShapeBoundary(node({ type: 'diamond', width: 120, height: 80 }), {
      x: 300,
      y: 300,
    });
    expect(Math.abs((point.x - 60) / 60) + Math.abs((point.y - 40) / 40)).toBeCloseTo(1, 10);
    expect(point.x).toBeLessThan(120);
  });
  it('intersects rounded corners on the corner circle', () => {
    const point = getShapeBoundary(node({ type: 'roundRect', width: 100, height: 100 }), {
      x: 200,
      y: 200,
    });
    expect(Math.hypot(point.x - 84, point.y - 84)).toBeCloseTo(16, 10);
    expect(point.x).toBeLessThan(100);
  });
  it('returns world points, finite arrowheads and midpoint labels with a background', () => {
    const board = scene(undefined, [section({ origin: { x: 50, y: 400 } })]);
    const result = routeEdge(edge({ label: 'Request' }), board, { measurer: fixedMeasurer })!;
    expect(result.start).toEqual({ x: 170, y: 432 });
    expect(result.end).toEqual({ x: 350, y: 432 });
    expect(result.arrowhead?.[0]).toEqual(result.end);
    expect(result.arrowLength).toBe(12);
    const label = result.label!;
    expect(label.box.x + label.box.width / 2).toBeCloseTo((result.start.x + result.end.x) / 2);
    expect(label.box.y + label.box.height / 2).toBeCloseTo(result.start.y);
    expect(label.background).toBe('#ffffff');
    expect(label.padding).toBeGreaterThan(0);
  });
  it('supports plain lines and unlabelled edges without decorative geometry', () => {
    const result = routeEdge(edge({ kind: 'line' }), scene())!;
    expect(result.arrowhead).toBeNull();
    expect(result.arrowLength).toBe(0);
    expect(result.label).toBeNull();
  });
  it('handles touching boundaries and coincident centers without NaN', () => {
    const touching = routeEdge(edge(), scene([node(), node({ id: 'g_b', x: 120 })]))!;
    expect(touching.start).toEqual(touching.end);
    expect(touching.arrowhead).toBeNull();
    expect(touching.degenerate).toBe(true);
    const overlapping = routeEdge(edge(), scene([node(), node({ id: 'g_b' })]))!;
    expect(overlapping.points.every(Number.isFinite)).toBe(true);
    expect(overlapping.degenerate).toBe(true);
    expect(overlapping.diagnostics).toHaveLength(1);
  });
  it('returns null for missing endpoints, sections and invalid topology', () => {
    expect(routeEdge(edge({ to: 'missing' }), scene())).toBeNull();
    expect(routeEdge(edge({ to: 'g_a' }), scene())).toBeNull();
    expect(routeEdge(edge(), scene(undefined, []))).toBeNull();
    expect(
      routeEdge(edge(), scene([node(), node({ id: 'g_b', sectionId: 'g_other' })])),
    ).toBeNull();
  });
  it('recomputes only when dependent geometry, label, type or section origin changes', () => {
    const router = createEdgeRouter({ measurer: fixedMeasurer });
    const connector = edge({ label: 'Request' });
    const board = scene();
    const initial = router.route(connector, board)!;
    const recolored = {
      ...board,
      nodes: { ...board.nodes, g_a: { ...board.nodes.g_a!, color: 'red' as const, revision: 2 } },
    };
    expect(router.route(connector, recolored)).toBe(initial);
    const moved = { ...board, nodes: { ...board.nodes, g_a: { ...board.nodes.g_a!, x: 50 } } };
    expect(router.route(connector, moved)!.start.x).toBe(170);
    const enlarged = {
      ...board,
      nodes: { ...board.nodes, g_a: { ...board.nodes.g_a!, width: 200 } },
    };
    expect(router.route(connector, enlarged)!.start.x).toBe(200);
    expect(router.route({ ...connector, label: 'New label' }, board)!.label!.text.fullText).toBe(
      'New label',
    );
    const shifted = {
      ...board,
      sections: { g_s: { ...board.sections.g_s!, origin: { x: 20, y: 30 } } },
    };
    expect(router.route(connector, shifted)!.start).toEqual({ x: 140, y: 62 });
    router.invalidate();
    expect(router.route(connector, board)).not.toBe(initial);
  });
  it('reuses geometry across immutable edge clones and bounds cache growth', () => {
    const router = createEdgeRouter({ measurer: fixedMeasurer, maxCachedEdges: 1 });
    const connector = edge();
    const board = scene();
    const initial = router.route(connector, board);
    expect(router.route({ ...connector, color: 'red', revision: 2 }, structuredClone(board))).toBe(
      initial,
    );
    router.route(edge({ id: 'g_other' }), board);
    expect(router.route(connector, board)).not.toBe(initial);
  });
  it('keeps long edge labels compact with a visible ellipsis and full inspector text', () => {
    const label = 'word\n'.repeat(39);
    const result = routeEdge(edge({ label }), scene(), { measurer: fixedMeasurer })!.label!;
    expect(result.text.lines).toHaveLength(3);
    expect(result.text.truncated).toBe(true);
    expect(result.text.lines.at(-1)).toContain('…');
    expect(result.text.fullText).toBe(label);
  });
});
