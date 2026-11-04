import type { Box, Point, Section, Viewport } from '../contracts';

function finitePoint(point: Point) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
    throw new Error('Point must be finite');
}
function checkViewport(viewport: Viewport) {
  finitePoint(viewport);
  if (!Number.isFinite(viewport.scale) || viewport.scale <= 0)
    throw new Error('Viewport scale must be positive and finite');
}
export function screenToWorld(point: Point, viewport: Viewport): Point {
  finitePoint(point);
  checkViewport(viewport);
  return { x: (point.x - viewport.x) / viewport.scale, y: (point.y - viewport.y) / viewport.scale };
}
export function worldToScreen(point: Point, viewport: Viewport): Point {
  finitePoint(point);
  checkViewport(viewport);
  return { x: point.x * viewport.scale + viewport.x, y: point.y * viewport.scale + viewport.y };
}
export function worldToSection(point: Point, section: Pick<Section, 'origin'>): Point {
  finitePoint(point);
  finitePoint(section.origin);
  return { x: point.x - section.origin.x, y: point.y - section.origin.y };
}
export function sectionToWorld(point: Point, section: Pick<Section, 'origin'>): Point {
  finitePoint(point);
  finitePoint(section.origin);
  return { x: point.x + section.origin.x, y: point.y + section.origin.y };
}
export function getWorldBounds(box: Box, section: Pick<Section, 'origin'>): Box {
  return { ...sectionToWorld(box, section), width: box.width, height: box.height };
}
