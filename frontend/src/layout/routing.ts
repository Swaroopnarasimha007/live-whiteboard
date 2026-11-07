import type { Box, Point } from '../contracts';
import { inflate, segmentHitsBox } from './collisions';

export interface Segment {
  a: Point;
  b: Point;
}
export interface Port {
  point: Point;
  exit: Point;
}
export function segmentConflict(first: Segment, second: Segment): 'shared' | 'crossing' | null {
  const r = { x: first.b.x - first.a.x, y: first.b.y - first.a.y };
  const s = { x: second.b.x - second.a.x, y: second.b.y - second.a.y };
  const q = { x: second.a.x - first.a.x, y: second.a.y - first.a.y };
  const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
  const denominator = cross(r, s);
  if (Math.abs(denominator) > 1e-6) {
    const t = cross(q, s) / denominator,
      u = cross(q, r) / denominator;
    return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6 ? 'crossing' : null;
  }
  if (Math.abs(cross(q, r)) > 1e-6) return null;
  const axis = Math.abs(r.x) > Math.abs(r.y) ? 'x' : 'y';
  const overlap =
    Math.min(Math.max(first.a[axis], first.b[axis]), Math.max(second.a[axis], second.b[axis])) -
    Math.max(Math.min(first.a[axis], first.b[axis]), Math.min(second.a[axis], second.b[axis]));
  return overlap > 1e-6 ? 'shared' : null;
}
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export function segments(points: readonly Point[]): Segment[] {
  return points.slice(1).map((b, i) => ({ a: points[i]!, b }));
}
export function simplify(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const p of points) {
    const b = result.at(-1);
    const a = result.at(-2);
    if (b && distance(b, p) < 1e-6) continue;
    if (
      a &&
      b &&
      ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) &&
      (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y) >= 0
    )
      result.pop();
    result.push(p);
  }
  return result;
}

/** Shared corridors are costly; a perpendicular crossing is permitted but discouraged. */
export function segmentPenalty(a: Point, b: Point, occupied: readonly Segment[]): number {
  let cost = 0;
  for (const s of occupied) {
    const box = {
      x: Math.min(s.a.x, s.b.x),
      y: Math.min(s.a.y, s.b.y),
      width: Math.abs(s.a.x - s.b.x),
      height: Math.abs(s.a.y - s.b.y),
    };
    if (!segmentHitsBox(a, b, inflate(box, 5))) continue;
    const parallel = (a.x === b.x && s.a.x === s.b.x) || (a.y === b.y && s.a.y === s.b.y);
    cost += parallel ? 2000 + distance(a, b) * 4 : 100;
  }
  return cost;
}

/** Bounded orthogonal routing with ports, obstacle clearance and reserved corridors. */
export function findRoute(
  starts: Port[],
  ends: Port[],
  obstacles: Box[],
  occupied: readonly Segment[],
  lane: number,
): Point[] | null {
  const clear = (a: Point, b: Point) => !obstacles.some((box) => segmentHitsBox(a, b, box));
  const xs = obstacles.flatMap((b) => [b.x, b.x + b.width]);
  const ys = obstacles.flatMap((b) => [b.y, b.y + b.height]);
  const margin = 32 + lane * 24;
  const lanesX = [Math.min(...xs) - margin, Math.max(...xs) + margin];
  const lanesY = [Math.min(...ys) - margin, Math.max(...ys) + margin];
  let best: Point[] | null = null;
  let score = Infinity;
  for (const start of starts)
    for (const end of ends) {
      const a = start.exit,
        b = end.exit;
      const candidates = [
        [a, { x: b.x, y: a.y }, b],
        [a, { x: a.x, y: b.y }, b],
        ...lanesX.map((x) => [a, { x, y: a.y }, { x, y: b.y }, b]),
        ...lanesY.map((y) => [a, { x: a.x, y }, { x: b.x, y }, b]),
      ];
      for (const path of candidates) {
        if (segments(path).some(({ a, b }) => !clear(a, b))) continue;
        const full = simplify([start.point, ...path, end.point]);
        const cost =
          segments(full).reduce(
            (sum, { a, b }) => sum + distance(a, b) + segmentPenalty(a, b, occupied),
            0,
          ) +
          full.length * 24;
        if (cost < score) {
          score = cost;
          best = full;
        }
      }
    }
  if (best) return best;

  // Visibility grid for corridors requiring more than three bends. Search work is bounded.
  const x = [
    ...new Set([...xs, ...lanesX, ...starts.map((p) => p.exit.x), ...ends.map((p) => p.exit.x)]),
  ].sort((a, b) => a - b);
  const y = [
    ...new Set([...ys, ...lanesY, ...starts.map((p) => p.exit.y), ...ends.map((p) => p.exit.y)]),
  ].sort((a, b) => a - b);
  if (x.length * y.length > 40_000) return null;
  const point = (id: number): Point => ({ x: x[id % x.length]!, y: y[Math.floor(id / x.length)]! });
  const id = (p: Point) => y.indexOf(p.y) * x.length + x.indexOf(p.x);
  const targets = new Map(ends.map((p) => [id(p.exit), p]));
  const costs = new Map<number, number>();
  const parent = new Map<number, number>();
  const roots = new Map<number, Port>();
  // Binary heap, avoiding a quadratic scan of the open set on dense boards.
  const heap: { id: number; cost: number }[] = [];
  const push = (entry: { id: number; cost: number }) => {
    heap.push(entry);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]!.cost <= entry.cost) break;
      heap[i] = heap[p]!;
      i = p;
    }
    heap[i] = entry;
  };
  const pop = () => {
    const first = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1]!.cost < heap[child]!.cost) child++;
        if (last.cost <= heap[child]!.cost) break;
        heap[i] = heap[child]!;
        i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  for (const port of starts) {
    const key = id(port.exit);
    costs.set(key, 0);
    roots.set(key, port);
    push({ id: key, cost: 0 });
  }
  for (let work = 0; heap.length && work < 80_000; work++) {
    const current = pop();
    if (current.cost !== costs.get(current.id)) continue;
    const end = targets.get(current.id);
    if (end) {
      const path: Point[] = [end.point];
      let key = current.id;
      while (parent.has(key)) {
        path.push(point(key));
        key = parent.get(key)!;
      }
      path.push(point(key), roots.get(key)!.point);
      return simplify(path.reverse());
    }
    const col = current.id % x.length,
      row = Math.floor(current.id / x.length);
    const neighbors = [
      col > 0 ? current.id - 1 : -1,
      col + 1 < x.length ? current.id + 1 : -1,
      row > 0 ? current.id - x.length : -1,
      row + 1 < y.length ? current.id + x.length : -1,
    ];
    for (const next of neighbors) {
      if (next < 0) continue;
      const a = point(current.id),
        b = point(next);
      if (!clear(a, b)) continue;
      const cost = current.cost + distance(a, b) + segmentPenalty(a, b, occupied) + 1;
      if (cost >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, cost);
      parent.set(next, current.id);
      push({ id: next, cost });
    }
  }
  return null;
}
