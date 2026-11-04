import { describe, expect, it } from 'vitest';
import { repairNodeCollisions, segmentHitsBox } from './collisions';
import { boxesOverlap } from './placement';
import { createEdgeRouter, routeEdge } from './edges';
import { edge, fixedMeasurer, node, scene, section } from './test-fixtures';
import type { Point } from '../contracts';
import { findRoute, segments, segmentConflict } from './routing';

describe('deterministic collision repair', () => {
  it('finds a multi-bend corridor when simple detours are blocked', () => {
    const obstacles = [
      { x: 0, y: 0, width: 200, height: 10 },
      { x: 0, y: 190, width: 200, height: 10 },
      { x: 0, y: 0, width: 10, height: 200 },
      { x: 190, y: 0, width: 10, height: 200 },
      { x: 60, y: 10, width: 10, height: 130 },
      { x: 130, y: 60, width: 10, height: 130 },
    ];
    const start = { x: 30, y: 30 },
      end = { x: 170, y: 160 };
    const path = findRoute(
      [{ point: start, exit: start }],
      [{ point: end, exit: end }],
      obstacles,
      [],
      0,
    );
    expect(path).not.toBeNull();
    expect(path![0]).toEqual(start);
    expect(path!.at(-1)).toEqual(end);
    for (const { a, b } of segments(path!))
      for (const obstacle of obstacles) expect(segmentHitsBox(a, b, obstacle)).toBe(false);
  });

  it('distinguishes genuine crossings, shared segments and touching endpoints', () => {
    const horizontal = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
    expect(segmentConflict(horizontal, { a: { x: 50, y: -10 }, b: { x: 50, y: 10 } })).toBe(
      'crossing',
    );
    expect(segmentConflict(horizontal, { a: { x: 50, y: 0 }, b: { x: 150, y: 0 } })).toBe('shared');
    expect(segmentConflict(horizontal, { a: { x: 100, y: 0 }, b: { x: 150, y: 0 } })).toBeNull();
  });
  it('repairs every movable overlap, respects protected geometry and is idempotent', () => {
    const board = scene([
      node({ id: 'g_locked', locked: true }),
      node({ id: 'g_edited', x: 240, lastManualRevision: 1 }),
      ...Array.from({ length: 24 }, (_, i) => node({ id: `g_n${i}`, x: i % 2 ? 20 : 250 })),
    ]);
    const protectedBefore = [
      structuredClone(board.nodes.g_locked),
      structuredClone(board.nodes.g_edited),
    ];
    const affected = new Set(['g_s']);
    expect(repairNodeCollisions(board.nodes, affected, new Set(), 1000).length).toBeGreaterThan(0);
    const nodes = Object.values(board.nodes);
    for (const [i, a] of nodes.entries())
      for (const b of nodes.slice(i + 1)) expect(boxesOverlap(a, b, 16)).toBe(false);
    expect([board.nodes.g_locked, board.nodes.g_edited]).toEqual(protectedBefore);
    expect(repairNodeCollisions(board.nodes, affected, new Set(), 1000)).toEqual([]);
  });

  it('detects diagonal segment intersections rather than only bounding box overlap', () => {
    const box = { x: 0, y: 0, width: 20, height: 20 };
    expect(segmentHitsBox({ x: -10, y: -10 }, { x: 30, y: 30 }, box)).toBe(true);
    expect(segmentHitsBox({ x: -10, y: 10 }, { x: 10, y: 30 }, box)).toBe(false);
    expect(segmentHitsBox({ x: 0, y: -10 }, { x: 0, y: 30 }, box)).toBe(false);
  });

  it('routes stacked obstacles, returns and parallel connections with clear labels', () => {
    const board = scene(
      [
        node(),
        node({ id: 'g_b', x: 600 }),
        node({ id: 'g_middle', x: 300 }),
        node({ id: 'g_above', x: 0, y: -100 }),
        node({ id: 'g_below', x: 600, y: 100 }),
      ],
      [section({ origin: { x: 150, y: 300 } })],
    );
    const edges = [
      edge({ id: 'g_1', label: 'Request' }),
      edge({ id: 'g_2', from: 'g_b', to: 'g_a', label: 'Response' }),
      edge({ id: 'g_3', label: 'Retry' }),
    ];
    board.edges = Object.fromEntries(edges.map((e) => [e.id, e]));
    const router = createEdgeRouter({ measurer: fixedMeasurer });
    const routes = edges.map((e) => router.route(e, board)!);
    expect(routes.every(Boolean)).toBe(true);
    const origin = board.sections.g_s!.origin;
    for (const [index, route] of routes.entries()) {
      const e = edges[index]!;
      for (let i = 2; i < route.points.length; i += 2) {
        const a = { x: route.points[i - 2]! - origin.x, y: route.points[i - 1]! - origin.y };
        const b = { x: route.points[i]! - origin.x, y: route.points[i + 1]! - origin.y };
        for (const n of Object.values(board.nodes)) {
          // Endpoints may only be touched at the boundary, never traversed.
          expect(segmentHitsBox(a, b, n), `${e.id} crosses ${n.id}`).toBe(false);
        }
      }
      const label = route.label!.box;
      for (const n of Object.values(board.nodes))
        expect(boxesOverlap(label, { ...n, x: n.x + origin.x, y: n.y + origin.y })).toBe(false);
      for (const other of routes.slice(index + 1))
        expect(boxesOverlap(label, other.label!.box)).toBe(false);
      expect(route.arrowhead![0]).toEqual(route.end);
      const previous: Point = { x: route.points.at(-4)!, y: route.points.at(-3)! };
      const base = {
        x: (route.arrowhead![1].x + route.arrowhead![2].x) / 2,
        y: (route.arrowhead![1].y + route.arrowhead![2].y) / 2,
      };
      expect(
        (route.end.x - base.x) * (route.end.x - previous.x) +
          (route.end.y - base.y) * (route.end.y - previous.y),
      ).toBeGreaterThan(0);
    }
    expect(new Set(routes.map((r) => JSON.stringify(r.points))).size).toBe(3);
    const reverseRouter = createEdgeRouter({ measurer: fixedMeasurer });
    for (const e of [...edges].reverse())
      expect(reverseRouter.route(e, board)).toEqual(router.route(e, board));
  });

  it('invalidates section routes when another edge or its label changes', () => {
    const board = scene();
    const first = edge({ id: 'g_first' });
    board.edges[first.id] = first;
    const router = createEdgeRouter({ measurer: fixedMeasurer });
    const before = router.route(first, board);
    board.edges.g_other = edge({ id: 'g_other', label: 'A new response', from: 'g_b', to: 'g_a' });
    expect(router.route(first, board)).not.toBe(before);
    expect(router.route(first, board)).toEqual(
      routeEdge(first, board, { measurer: fixedMeasurer }),
    );
  });
});
