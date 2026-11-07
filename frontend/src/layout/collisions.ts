import type { Box, Node, Point } from '../contracts';
import { COLLISION_GAP, COORDINATE_LIMIT } from './constants';
import { boxesOverlap, resolvePlacement } from './placement';

export const movableGenerated = (node: Node) =>
  node.source === 'generated' && !node.locked && node.lastManualRevision === 0;

export function inflate(box: Box, gap: number): Box {
  return {
    x: box.x - gap,
    y: box.y - gap,
    width: box.width + gap * 2,
    height: box.height + gap * 2,
  };
}

/** Open-interior intersection: travelling along the clearance boundary is allowed. */
export function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
  let low = 0;
  let high = 1;
  for (const [start, delta, min, max] of [
    [a.x, b.x - a.x, box.x + 1e-6, box.x + box.width - 1e-6],
    [a.y, b.y - a.y, box.y + 1e-6, box.y + box.height - 1e-6],
  ]) {
    if (Math.abs(delta!) < 1e-9) {
      if (start! < min! || start! > max!) return false;
    } else {
      const t1 = (min! - start!) / delta!;
      const t2 = (max! - start!) / delta!;
      low = Math.max(low, Math.min(t1, t2));
      high = Math.min(high, Math.max(t1, t2));
      if (low > high) return false;
    }
  }
  return low <= high;
}

/** Place protected/unchanged nodes first, then repair affected generated geometry.
 * Each accepted node becomes an obstacle, so repairs cannot introduce a new collision.
 */
export function repairNodeCollisions(
  nodes: Record<string, Node>,
  affected: ReadonlySet<string>,
  changed: ReadonlySet<string>,
  widthLimit: number,
): string[] {
  const repaired: string[] = [];
  for (const sectionId of [...affected].sort()) {
    const peers = Object.values(nodes).filter((n) => n.sectionId === sectionId);
    const fixed = peers.filter((n) => !movableGenerated(n));
    const movable = peers
      .filter(movableGenerated)
      .sort(
        (a, b) => Number(changed.has(a.id)) - Number(changed.has(b.id)) || a.id.localeCompare(b.id),
      );
    const placed = [...fixed];
    for (const node of movable) {
      if (placed.some((other) => boxesOverlap(node, other, COLLISION_GAP))) {
        // Try the closest obstacle boundary before using the bounded shell/append search.
        const candidates = placed
          .flatMap((other) => [
            { x: other.x + other.width + COLLISION_GAP, y: node.y },
            { x: other.x - node.width - COLLISION_GAP, y: node.y },
            { x: node.x, y: other.y + other.height + COLLISION_GAP },
            { x: node.x, y: other.y - node.height - COLLISION_GAP },
          ])
          .filter(
            (p) =>
              Math.abs(p.x) <= COORDINATE_LIMIT &&
              Math.abs(p.y) <= COORDINATE_LIMIT &&
              p.x >= 0 &&
              p.x + node.width <= Math.max(widthLimit, node.width) &&
              !placed.some((other) => boxesOverlap({ ...node, ...p }, other, COLLISION_GAP)),
          )
          .sort(
            (a, b) =>
              Math.hypot(a.x - node.x, a.y - node.y) - Math.hypot(b.x - node.x, b.y - node.y),
          );
        const position =
          candidates[0] ??
          resolvePlacement({
            node,
            nodes: placed,
            source: 'generated',
            at: [0, Math.max(0, ...placed.map((n) => n.y + n.height)) + 64],
          });
        node.x = position.x;
        node.y = position.y;
        repaired.push(node.id);
      }
      placed.push(node);
    }
  }
  return repaired;
}

/** Last bounded recovery pass: open routing corridors without moving protected content. */
export function spreadGeneratedSection(
  nodes: Record<string, Node>,
  sectionId: string,
  widthLimit: number,
): string[] {
  const peers = Object.values(nodes).filter((n) => n.sectionId === sectionId);
  const placed = peers.filter((n) => !movableGenerated(n));
  const movable = peers
    .filter(movableGenerated)
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const changed: string[] = [];
  let x = 0,
    y = Math.max(0, ...placed.map((n) => n.y + n.height + 160)),
    rowHeight = 0;
  for (const node of movable) {
    if (x > 0 && x + node.width > widthLimit) {
      x = 0;
      y += rowHeight + 160;
      rowHeight = 0;
    }
    const position = resolvePlacement({ node, nodes: placed, source: 'generated', at: [x, y] });
    if (position.x !== node.x || position.y !== node.y) changed.push(node.id);
    node.x = position.x;
    node.y = position.y;
    x = node.x + node.width + 160;
    rowHeight = Math.max(rowHeight, node.height);
    placed.push(node);
  }
  return changed;
}
