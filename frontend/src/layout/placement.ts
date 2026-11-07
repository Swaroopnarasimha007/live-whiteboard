import type { Box, Node, Placement, Point, Source } from '../contracts';
import {
  COLLISION_GAP,
  COORDINATE_LIMIT,
  MAX_PLACEMENT_CANDIDATES,
  PLACEMENT_GAP,
} from './constants';

export interface PlacementInput {
  node: Pick<Node, 'id' | 'sectionId' | 'x' | 'y' | 'width' | 'height'>;
  nodes: readonly Node[];
  source: Source;
  at?: readonly [number, number];
  place?: Placement;
  maxCandidates?: number;
}
export interface PlacementResult extends Point {
  attempts: number;
  corrected: boolean;
  exhausted: boolean;
  diagnostics: readonly string[];
}
export function boxesOverlap(a: Box, b: Box, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}
const inRange = (point: Point) =>
  Number.isFinite(point.x) &&
  Number.isFinite(point.y) &&
  Math.abs(point.x) <= COORDINATE_LIMIT &&
  Math.abs(point.y) <= COORDINATE_LIMIT;

function* candidates(origin: Point, width: number, height: number): Generator<Point> {
  yield origin;
  for (let ring = 1; ; ring++) {
    // Clockwise square shells, beginning on the right; each lattice slot is visited once.
    for (let y = 0; y <= ring; y++) yield { x: origin.x + ring * width, y: origin.y + y * height };
    for (let x = ring - 1; x >= -ring; x--)
      yield { x: origin.x + x * width, y: origin.y + ring * height };
    for (let y = ring - 1; y >= -ring; y--)
      yield { x: origin.x - ring * width, y: origin.y + y * height };
    for (let x = -ring + 1; x <= ring; x++)
      yield { x: origin.x + x * width, y: origin.y - ring * height };
    for (let y = -ring + 1; y < 0; y++)
      yield { x: origin.x + ring * width, y: origin.y + y * height };
  }
}

export function resolvePlacement(input: PlacementInput): PlacementResult {
  const { node } = input;
  if (![node.width, node.height].every((n) => Number.isFinite(n) && n >= 24 && n <= 2_000))
    throw new Error('Invalid placement dimensions');
  if (input.at && input.place) throw new Error('Use at OR place');
  if (input.at && !input.at.every((n) => Number.isFinite(n) && Math.abs(n) <= COORDINATE_LIMIT))
    throw new Error('Invalid absolute placement coordinates');
  const max = input.maxCandidates ?? MAX_PLACEMENT_CANDIDATES;
  if (!Number.isSafeInteger(max) || max < 1 || max > 4_096)
    throw new Error('Candidate bound must be between 1 and 4096');
  const obstacles = input.nodes.filter((n) => n.id !== node.id && n.sectionId === node.sectionId);
  let preferred: Point = input.at ? { x: input.at[0], y: input.at[1] } : { x: 0, y: 0 };
  if (input.place) {
    const [direction, anchorId] = Object.entries(input.place)[0]!;
    const anchor = obstacles.find((n) => n.id === anchorId);
    if (!anchor)
      throw new Error(`Placement dependency unavailable in section ${node.sectionId}: ${anchorId}`);
    preferred = { x: anchor.x, y: anchor.y };
    if (direction === 'rightOf') preferred.x += anchor.width + PLACEMENT_GAP;
    else if (direction === 'leftOf') preferred.x -= node.width + PLACEMENT_GAP;
    else if (direction === 'below') preferred.y += anchor.height + PLACEMENT_GAP;
    else if (direction === 'above') preferred.y -= node.height + PLACEMENT_GAP;
    else throw new Error('Unsupported relative placement');
  }
  if (input.source === 'manual' && (input.at || input.place)) {
    if (!inRange(preferred)) throw new Error('Manual placement exceeds coordinate limits');
    return { ...preferred, attempts: 1, corrected: false, exhausted: false, diagnostics: [] };
  }
  const available = (point: Point) =>
    inRange(point) &&
    !obstacles.some((other) =>
      boxesOverlap({ ...point, width: node.width, height: node.height }, other, COLLISION_GAP),
    );
  const search = candidates(preferred, node.width + PLACEMENT_GAP, node.height + PLACEMENT_GAP);
  for (let i = 0; i < max; i++) {
    const point = search.next().value as Point;
    if (available(point))
      return {
        ...point,
        attempts: i + 1,
        corrected: point.x !== preferred.x || point.y !== preferred.y,
        exhausted: false,
        diagnostics: [],
      };
  }
  // Outside the union is guaranteed free if it is still representable. Four finite fallbacks.
  const left = Math.min(0, ...obstacles.map((n) => n.x));
  const top = Math.min(0, ...obstacles.map((n) => n.y));
  const right = Math.max(0, ...obstacles.map((n) => n.x + n.width));
  const bottom = Math.max(0, ...obstacles.map((n) => n.y + n.height));
  const fallbacks = [
    {
      x: Math.max(-COORDINATE_LIMIT, Math.min(COORDINATE_LIMIT, preferred.x)),
      y: bottom + PLACEMENT_GAP,
    },
    {
      x: right + PLACEMENT_GAP,
      y: Math.max(-COORDINATE_LIMIT, Math.min(COORDINATE_LIMIT, preferred.y)),
    },
    { x: left - node.width - PLACEMENT_GAP, y: 0 },
    { x: 0, y: top - node.height - PLACEMENT_GAP },
  ];
  for (let index = 0; index < fallbacks.length; index++) {
    const point = fallbacks[index]!;
    if (available(point))
      return {
        ...point,
        attempts: max + index + 1,
        corrected: true,
        exhausted: true,
        diagnostics: [
          `Placement search exhausted ${max} slots for ${node.id}; appended in free space`,
        ],
      };
  }
  throw new Error(
    `No representable free placement for ${node.id} after ${max} slots and 4 append attempts`,
  );
}
