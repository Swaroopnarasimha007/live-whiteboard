import { describe, expect, it } from 'vitest';
import { PLACEMENT_GAP } from './constants';
import { boxesOverlap, resolvePlacement } from './placement';
import { node } from './test-fixtures';

describe('bounded incremental placement', () => {
  it.each([
    [{ rightOf: 'g_a' }, { x: 184, y: 0 }],
    [{ below: 'g_a' }, { x: 0, y: 128 }],
    [{ leftOf: 'g_a' }, { x: -184, y: 0 }],
    [{ above: 'g_a' }, { x: 0, y: -128 }],
  ] as const)('uses measured bounds and gap for %j', (place, expected) => {
    expect(
      resolvePlacement({
        node: node({ id: 'g_new' }),
        nodes: [node()],
        source: 'generated',
        place,
      }),
    ).toMatchObject(expected);
  });
  it('respects intentional manual overlap and exact world coordinates', () => {
    const result = resolvePlacement({
      node: node({ id: 'm_new' }),
      nodes: [node()],
      source: 'manual',
      at: [12.5, -9],
    });
    expect(result).toMatchObject({ x: 12.5, y: -9, corrected: false });
    expect(boxesOverlap({ ...node(), x: result.x, y: result.y }, node())).toBe(true);
  });
  it('avoids manual and generated committed bounds without moving them', () => {
    const obstacles = [node(), node({ id: 'g_b', x: 184 }), node({ id: 'g_c', x: -184 })];
    const before = structuredClone(obstacles);
    const result = resolvePlacement({
      node: node({ id: 'g_new' }),
      nodes: obstacles,
      source: 'generated',
      at: [0, 0],
    });
    expect(result.corrected).toBe(true);
    expect(obstacles.some((other) => boxesOverlap({ ...node(), ...result }, other))).toBe(false);
    expect(obstacles).toEqual(before);
    expect(
      resolvePlacement({
        node: node({ id: 'g_new' }),
        nodes: obstacles,
        source: 'generated',
        at: [0, 0],
      }),
    ).toEqual(result);
  });
  it('appends after exhausting a bounded search and diagnoses the fallback', () => {
    const result = resolvePlacement({
      node: node({ id: 'g_new' }),
      nodes: [node()],
      source: 'generated',
      maxCandidates: 1,
    });
    expect(result).toMatchObject({ x: 0, y: 64 + PLACEMENT_GAP, attempts: 2, exhausted: true });
    expect(result.diagnostics[0]).toContain('exhausted 1');
  });
  it('ignores nodes in other sections and never treats at as a grid index', () => {
    expect(
      resolvePlacement({
        node: node({ id: 'g_new' }),
        nodes: [node({ sectionId: 'g_elsewhere' })],
        source: 'generated',
        at: [2, 3],
      }),
    ).toMatchObject({ x: 2, y: 3, corrected: false });
  });
  it('rejects unavailable anchors, unbounded searches and conflicting hints', () => {
    expect(() =>
      resolvePlacement({
        node: node(),
        nodes: [],
        source: 'generated',
        place: { below: 'missing' },
      }),
    ).toThrow('unavailable');
    expect(() =>
      resolvePlacement({ node: node(), nodes: [], source: 'generated', maxCandidates: 0 }),
    ).toThrow();
    expect(() =>
      resolvePlacement({
        node: node(),
        nodes: [],
        source: 'generated',
        at: [0, 0],
        place: { below: 'g_a' },
      }),
    ).toThrow('OR');
  });
  it('terminates when free append space cannot fit in coordinate limits', () => {
    const obstacles = [
      node({ x: 100_000, y: 100_000, width: 2_000, height: 2_000 }),
      node({ id: 'g_b', x: -100_000, y: -100_000, width: 2_000, height: 2_000 }),
      node({ id: 'g_c' }),
    ];
    expect(() =>
      resolvePlacement({
        node: node({ id: 'g_new' }),
        nodes: obstacles,
        source: 'generated',
        maxCandidates: 1,
      }),
    ).toThrow('No representable');
  });
});
