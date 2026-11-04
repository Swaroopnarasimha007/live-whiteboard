import type { Box, Edge, Node, Point, Scene } from '../contracts';
import {
  EDGE_LABEL_BACKGROUND,
  EDGE_LABEL_LINE_HEIGHT,
  EDGE_LABEL_SIZE,
  ROUND_RECT_RADIUS,
} from './constants';
import { fitText, getTextMeasurer, wrapText, type TextLayout, type TextOptions } from './text';
import { sectionToWorld } from './transforms';
import { inflate, segmentHitsBox } from './collisions';
import { boxesOverlap } from './placement';
import {
  findRoute,
  segments,
  segmentPenalty,
  segmentConflict,
  type Segment,
  type Port,
} from './routing';

type ShapeBounds = Pick<Node, 'x' | 'y' | 'width' | 'height' | 'type'>;
export interface RoutedEdge {
  start: Point;
  end: Point;
  points: readonly number[];
  arrowhead: readonly [Point, Point, Point] | null;
  arrowLength: number;
  arrowWidth: number;
  label: { box: Box; text: TextLayout; background: string; padding: number } | null;
  degenerate: boolean;
  diagnostics: readonly string[];
}
const EPSILON = 1e-9;
const validBox = (box: Box) =>
  [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0;

/** Ray from the shape center through toward; the returned point is in the same coordinate space. */
export function getShapeBoundary(node: ShapeBounds, toward: Point): Point {
  if (!validBox(node) || !Number.isFinite(toward.x) || !Number.isFinite(toward.y))
    throw new Error('Cannot intersect non-finite/empty shape geometry');
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const rx = node.width / 2;
  const ry = node.height / 2;
  let dx = toward.x - cx;
  let dy = toward.y - cy;
  if (Math.hypot(dx, dy) < EPSILON) {
    dx = 1;
    dy = 0;
  }
  let t: number;
  if (node.type === 'ellipse' || node.type === 'circle') t = 1 / Math.hypot(dx / rx, dy / ry);
  else if (node.type === 'diamond') t = 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry);
  else {
    t = Math.min(dx === 0 ? Infinity : rx / Math.abs(dx), dy === 0 ? Infinity : ry / Math.abs(dy));
    if (node.type === 'roundRect') {
      const radius = Math.min(ROUND_RECT_RADIUS, rx, ry);
      if (Math.abs(dx * t) > rx - radius && Math.abs(dy * t) > ry - radius) {
        const cornerX = Math.sign(dx) * (rx - radius);
        const cornerY = Math.sign(dy) * (ry - radius);
        const a = dx * dx + dy * dy;
        const projection = dx * cornerX + dy * cornerY;
        const c = cornerX * cornerX + cornerY * cornerY - radius * radius;
        t = (projection + Math.sqrt(Math.max(0, projection * projection - a * c))) / a;
      }
    }
  }
  return { x: cx + dx * t, y: cy + dy * t };
}

function routeSingleEdge(
  edge: Edge,
  scene: Pick<Scene, 'nodes' | 'sections'>,
  options: TextOptions = {},
  occupied: readonly Segment[] = [],
  labels: readonly Box[] = [],
  lane = 0,
): RoutedEdge | null {
  const from = Object.hasOwn(scene.nodes, edge.from) ? scene.nodes[edge.from] : undefined;
  const to = Object.hasOwn(scene.nodes, edge.to) ? scene.nodes[edge.to] : undefined;
  const section = Object.hasOwn(scene.sections, edge.sectionId)
    ? scene.sections[edge.sectionId]
    : undefined;
  if (
    !from ||
    !to ||
    !section ||
    from.id === to.id ||
    from.sectionId !== edge.sectionId ||
    to.sectionId !== edge.sectionId ||
    !validBox(from) ||
    !validBox(to)
  )
    return null;
  const a = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const b = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const coincident = Math.hypot(a.x - b.x, a.y - b.y) < EPSILON;
  const startLocal = getShapeBoundary(from, coincident ? { x: a.x + 1, y: a.y } : b);
  const endLocal = getShapeBoundary(to, coincident ? { x: b.x - 1, y: b.y } : a);
  const peers = Object.values(scene.nodes).filter((n) => n.sectionId === edge.sectionId);
  const nodeBoxes = peers.map((n) => inflate(n, 10));
  // Reserved geometry is section-local; translate only at the rendering boundary.
  const obstacles = [...nodeBoxes, ...labels.map((box) => inflate(box, 8))];
  const ports = (node: Node): Port[] => {
    const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
    return [
      { x: node.x + node.width + 16, y: center.y },
      { x: center.x, y: node.y - 16 },
      { x: center.x, y: node.y + node.height + 16 },
      { x: node.x - 16, y: center.y },
    ]
      .map((exit) => ({ exit, point: getShapeBoundary(node, exit) }))
      .filter(
        (port) =>
          !peers.some(
            (other) =>
              other.id !== node.id && segmentHitsBox(port.point, port.exit, inflate(other, 10)),
          ) && !labels.some((box) => segmentHitsBox(port.point, port.exit, inflate(box, 8))),
      );
  };
  const directClear = !obstacles.some((box, i) =>
    i < peers.length && (peers[i]!.id === from.id || peers[i]!.id === to.id)
      ? false
      : segmentHitsBox(startLocal, endLocal, box),
  );
  const direct =
    coincident ||
    (b.x >= a.x && directClear && segmentPenalty(startLocal, endLocal, occupied) === 0);
  const local = direct
    ? [startLocal, endLocal]
    : findRoute(ports(from), ports(to), obstacles, occupied, lane);
  if (!local) return null;
  const world = local.map((p) => sectionToWorld(p, section));
  const start = world[0]!;
  const end = world.at(-1)!;
  const points = world.flatMap((p) => [p.x, p.y]);
  const tail = world.at(-2)!;
  const length = Math.hypot(end.x - tail.x, end.y - tail.y);
  const arrowLength = edge.kind === 'arrow' ? Math.min(12, length / 3) : 0;
  const arrowWidth = (arrowLength * 2) / 3;
  let arrowhead: RoutedEdge['arrowhead'] = null;
  if (edge.kind === 'arrow' && length > EPSILON) {
    const ux = (end.x - tail.x) / length;
    const uy = (end.y - tail.y) / length;
    const base = { x: end.x - ux * arrowLength, y: end.y - uy * arrowLength };
    arrowhead = [
      end,
      { x: base.x - (uy * arrowWidth) / 2, y: base.y + (ux * arrowWidth) / 2 },
      { x: base.x + (uy * arrowWidth) / 2, y: base.y - (ux * arrowWidth) / 2 },
    ];
  }
  const diagnostics: string[] = coincident
    ? ['Endpoint centers coincide; deterministic horizontal attachments used']
    : [];
  const conflicts = new Set(
    segments(local)
      .flatMap((segment) => occupied.map((other) => segmentConflict(segment, other)))
      .filter(Boolean),
  );
  if (conflicts.has('crossing'))
    diagnostics.push(`Connector ${edge.id} has a crossing after bounded routing`);
  if (conflicts.has('shared'))
    diagnostics.push(`Connector ${edge.id} shares a corridor after bounded routing`);
  let label: RoutedEdge['label'] = null;
  if (edge.label) {
    const measurer = getTextMeasurer(options);
    const lines = wrapText(edge.label, 220, { measurer, fontSize: EDGE_LABEL_SIZE });
    const text = fitText(edge.label, 220, Math.min(3, lines.length) * EDGE_LABEL_LINE_HEIGHT, {
      measurer,
      fontSize: EDGE_LABEL_SIZE,
      lineHeight: EDGE_LABEL_LINE_HEIGHT,
    });
    const padding = 6;
    const width = text.width + padding * 2;
    const height = text.height + padding * 2;
    let labelBox: Box | undefined;
    const ownSegments = segments(local);
    const sorted = [...ownSegments].sort(
      (a, b) => Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y) - Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y),
    );
    for (const offset of [0, 16, -16, 32, -32, 64, -64, 96, -96, 160, -160, 240, -240]) {
      for (const host of sorted) {
        const len = Math.hypot(host.b.x - host.a.x, host.b.y - host.a.y);
        const ux = len > EPSILON ? (host.b.x - host.a.x) / len : 1;
        const uy = len > EPSILON ? (host.b.y - host.a.y) / len : 0;
        for (const t of [0.5, 0.25, 0.75]) {
          const box = {
            x: host.a.x + (host.b.x - host.a.x) * t - width / 2 + uy * offset,
            y: host.a.y + (host.b.y - host.a.y) * t - height / 2 - ux * offset,
            width,
            height,
          };
          if (
            peers.some((n) => boxesOverlap(box, n, 8)) ||
            labels.some((l) => boxesOverlap(box, l, 8))
          )
            continue;
          if (occupied.some(({ a, b }) => segmentHitsBox(a, b, inflate(box, 4)))) continue;
          if (ownSegments.some((s) => s !== host && segmentHitsBox(s.a, s.b, inflate(box, 4))))
            continue;
          // Keep the label clear of endpoint arrowheads, even when centered on its own host.
          const tip = local.at(-1)!;
          if (boxesOverlap(box, { x: tip.x - 14, y: tip.y - 14, width: 28, height: 28 })) continue;
          labelBox = box;
          break;
        }
        if (labelBox) break;
      }
      if (labelBox) break;
    }
    if (!labelBox) return null;
    label = {
      box: { ...labelBox, x: labelBox.x + section.origin.x, y: labelBox.y + section.origin.y },
      text,
      background: EDGE_LABEL_BACKGROUND,
      padding,
    };
  }
  return {
    start,
    end,
    points,
    arrowhead,
    arrowLength,
    arrowWidth,
    label,
    degenerate: coincident || length < EPSILON,
    diagnostics,
  };
}

type RoutingScene = Pick<Scene, 'nodes' | 'sections'> & Partial<Pick<Scene, 'edges'>>;

function routeSection(
  edge: Edge,
  scene: RoutingScene,
  options: TextOptions,
): Map<string, RoutedEdge | null> {
  const edges = Object.values({ ...scene.edges, [edge.id]: edge })
    .filter((e) => e.sectionId === edge.sectionId)
    .sort((a, b) => a.id.localeCompare(b.id));
  const occupied: Segment[] = [];
  const labels: Box[] = [];
  const result = new Map<string, RoutedEdge | null>();
  const origin = scene.sections[edge.sectionId]?.origin;
  if (!origin) return new Map([[edge.id, null]]);
  for (const [index, e] of edges.entries()) {
    const route = routeSingleEdge(e, scene, options, occupied, labels, index);
    result.set(e.id, route);
    if (!route) continue;
    const local: Point[] = [];
    for (let i = 0; i < route.points.length; i += 2)
      local.push({ x: route.points[i]! - origin.x, y: route.points[i + 1]! - origin.y });
    occupied.push(...segments(local));
    if (route.label)
      labels.push({
        ...route.label.box,
        x: route.label.box.x - origin.x,
        y: route.label.box.y - origin.y,
      });
  }
  return result;
}

export function routeEdge(
  edge: Edge,
  scene: RoutingScene,
  options: TextOptions = {},
): RoutedEdge | null {
  return routeSection(edge, scene, options).get(edge.id) ?? null;
}

/** Cache entire section plans: route choices cannot depend on renderer/culling call order. */
export interface EdgeRouterOptions extends TextOptions {
  maxCachedEdges?: number;
}
export function createEdgeRouter(options: EdgeRouterOptions = {}) {
  const max = options.maxCachedEdges ?? 5_000;
  if (!Number.isSafeInteger(max) || max < 1)
    throw new Error('Edge cache capacity must be a positive integer');
  const cache = new Map<string, { signature: string; results: Map<string, RoutedEdge | null> }>();
  let count = 0;
  return {
    route(edge: Edge, scene: RoutingScene) {
      const signature = JSON.stringify([
        scene.sections[edge.sectionId]?.origin,
        Object.values(scene.nodes)
          .filter((n) => n.sectionId === edge.sectionId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((n) => [n.id, n.type, n.x, n.y, n.width, n.height]),
        Object.values({ ...scene.edges, [edge.id]: edge })
          .filter((e) => e.sectionId === edge.sectionId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((e) => [e.id, e.from, e.to, e.kind, e.label]),
      ]);
      const old = cache.get(edge.sectionId);
      if (old?.signature === signature) return old.results.get(edge.id) ?? null;
      if (old) {
        count -= old.results.size;
        cache.delete(edge.sectionId);
      }
      const results = routeSection(edge, scene, options);
      if (results.size <= max) {
        cache.set(edge.sectionId, { signature, results });
        count += results.size;
        while (count > max) {
          const key = cache.keys().next().value!;
          count -= cache.get(key)!.results.size;
          cache.delete(key);
        }
      }
      return results.get(edge.id) ?? null;
    },
    invalidate: () => {
      cache.clear();
      count = 0;
    },
  };
}
