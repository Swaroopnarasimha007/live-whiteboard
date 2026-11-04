import type { Box, Scene, Viewport } from '../contracts';
import { createEdgeRouter, getWorldBounds, screenToWorld } from '../layout';
import type { BoardSize } from './viewport';

export function intersects(a: Box, b: Box): boolean {
  return (
    a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
  );
}
export function segmentIntersectsBox(
  points: readonly [number, number, number, number],
  box: Box,
): boolean {
  const [x1, y1, x2, y2] = points;
  let min = 0;
  let max = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  for (const [p, q] of [
    [-dx, x1 - box.x],
    [dx, box.x + box.width - x1],
    [-dy, y1 - box.y],
    [dy, box.y + box.height - y1],
  ]) {
    if (p === 0) {
      if (q! < 0) return false;
      continue;
    }
    const t = q! / p!;
    if (p! < 0) min = Math.max(min, t);
    else max = Math.min(max, t);
    if (min > max) return false;
  }
  return true;
}
export function visibleScene(
  scene: Scene,
  viewport: Viewport,
  size: BoardSize,
  router: ReturnType<typeof createEdgeRouter>,
  overscanPx = 120,
  pinnedIds: ReadonlySet<string> = new Set(),
) {
  const origin = screenToWorld({ x: -overscanPx, y: -overscanPx }, viewport);
  const bounds = {
    ...origin,
    width: (size.width + overscanPx * 2) / viewport.scale,
    height: (size.height + overscanPx * 2) / viewport.scale,
  };
  return {
    sections: Object.values(scene.sections).filter((s) =>
      intersects(getWorldBounds(s.bounds, s), bounds),
    ),
    nodes: Object.values(scene.nodes).filter(
      (n) =>
        scene.sections[n.sectionId] &&
        (pinnedIds.has(n.id) ||
          intersects(getWorldBounds(n, scene.sections[n.sectionId]!), bounds)),
    ),
    edges: Object.values(scene.edges).flatMap((edge) => {
      const route = router.route(edge, scene);
      return route &&
        (route.points.some(
          (_, i) =>
            i % 2 === 0 &&
            i + 3 < route.points.length &&
            segmentIntersectsBox(
              [route.points[i]!, route.points[i + 1]!, route.points[i + 2]!, route.points[i + 3]!],
              bounds,
            ),
        ) ||
          (route.label && intersects(route.label.box, bounds)))
        ? [{ edge, route }]
        : [];
    }),
  };
}
export function gridLines(viewport: Viewport, size: BoardSize) {
  let spacing = 32;
  while (
    spacing * viewport.scale < 24 ||
    (size.width + size.height) / (spacing * viewport.scale) > 500
  )
    spacing *= 2;
  const step = spacing * viewport.scale;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = ((viewport.x % step) + step) % step; x <= size.width && xs.length < 512; x += step)
    xs.push(x);
  for (let y = ((viewport.y % step) + step) % step; y <= size.height && ys.length < 512; y += step)
    ys.push(y);
  return { spacing, xs, ys };
}
