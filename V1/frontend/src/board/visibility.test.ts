import { expect, it } from 'vitest';
import { createEdgeRouter, estimatedTextMeasurer } from '../layout';
import { edge, node, scene, section } from '../layout/test-fixtures';
import { gridLines, segmentIntersectsBox, visibleScene } from './visibility';
import { normalizedWheel } from './navigation';

it('keeps a crossing connector when both endpoint shapes are offscreen', () => {
  const board = scene([node({ x: -2_000 }), node({ id: 'g_b', x: 2_000 })]);
  board.edges.g_e = edge();
  const visible = visibleScene(
    board,
    { x: 0, y: 0, scale: 1 },
    { width: 800, height: 600 },
    createEdgeRouter({ measurer: estimatedTextMeasurer }),
    0,
  );
  expect(visible.nodes).toHaveLength(0);
  expect(visible.edges).toHaveLength(1);
});
it('culls far nodes/sections, preserving pinned selection and section-local translations', () => {
  const board = scene(
    [node(), node({ id: 'g_b', sectionId: 'g_s2' })],
    [section(), section({ id: 'g_s2', order: 1, origin: { x: 0, y: 2_000 } })],
  );
  const router = createEdgeRouter();
  const size = { width: 800, height: 600 };
  const viewport = { x: 0, y: 0, scale: 1 };
  expect(visibleScene(board, viewport, size, router, 0).nodes.map((n) => n.id)).toEqual(['g_a']);
  expect(visibleScene(board, viewport, size, router, 0).sections).toHaveLength(1);
  expect(visibleScene(board, viewport, size, router, 0, new Set(['g_b'])).nodes).toHaveLength(2);
});
it.each([
  [[-10, 5, 20, 5], true],
  [[5, -10, 5, 20], true],
  [[-10, -10, 20, 20], true],
  [[-10, -5, -2, -1], false],
  [[0, 0, 0, 0], true],
  [[-2, -2, -2, -2], false],
] as const)('clips segment %j to viewport without NaN', (points, expected) => {
  expect(segmentIntersectsBox(points, { x: 0, y: 0, width: 10, height: 10 })).toBe(expected);
});
it('bounds grid work at minimum zoom and large display sizes', () => {
  const lines = gridLines({ x: -100.5, y: 90, scale: 0.15 }, { width: 16_000, height: 8_000 });
  expect(lines.xs.length + lines.ys.length).toBeLessThanOrEqual(502);
  expect(lines.spacing * 0.15).toBeGreaterThanOrEqual(24);
});
it('normalizes both wheel axes for pixel, line and page modes', () => {
  expect(normalizedWheel({ deltaX: 2, deltaY: 3, deltaMode: 0 }, 600)).toEqual({ x: 2, y: 3 });
  expect(normalizedWheel({ deltaX: 2, deltaY: 3, deltaMode: 1 }, 600)).toEqual({ x: 32, y: 48 });
  expect(normalizedWheel({ deltaX: 2, deltaY: 3, deltaMode: 2 }, 600)).toEqual({
    x: 1_200,
    y: 1_800,
  });
});
