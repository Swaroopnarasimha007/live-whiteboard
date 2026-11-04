import type { Point } from '../contracts';
import { MAX_ZOOM, MIN_ZOOM, type ViewportController } from './viewport';

export interface NavigationOptions {
  tool: 'select' | 'hand';
  onNavigationStart?: () => void;
  onPanningChange?: (panning: boolean) => void;
  onSpaceChange?: (space: boolean) => void;
}
export function isTextTarget(target: EventTarget | null): boolean {
  return (
    typeof HTMLElement !== 'undefined' &&
    target instanceof HTMLElement &&
    (!!target.closest('input,textarea,select,[role="textbox"]') || target.isContentEditable)
  );
}
export function normalizedWheel(
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>,
  pageHeight: number,
): Point {
  const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1;
  return { x: event.deltaX * factor, y: event.deltaY * factor };
}

/** Native capture listeners arbitrate camera gestures before Konva/editor listeners. */
export function bindNavigation(
  element: HTMLElement,
  viewport: ViewportController,
  options: NavigationOptions,
): () => void {
  let space = false;
  let pan: { id: number; point: Point } | undefined;
  const touches = new Map<number, Point>();
  const captures = new Set<number>();
  let touchGesture = false;
  let pinch: { midpoint: Point; distance: number; world: Point; scale: number } | undefined;
  const screenPoint = (event: { clientX: number; clientY: number }): Point => {
    const r = element.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  };
  const capture = (id: number) => {
    try {
      element.setPointerCapture(id);
      captures.add(id);
    } catch {
      /* Synthetic pointers may not be capturable. */
    }
  };
  const release = (id: number) => {
    captures.delete(id);
    try {
      if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    } catch {
      /* The element/pointer may already have detached during teardown. */
    }
  };
  const stop = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const begin = () => {
    viewport.suspendFollow();
    options.onNavigationStart?.();
    options.onPanningChange?.(true);
  };
  const pair = () => {
    const points = [...touches.values()];
    if (points.length < 2) return undefined;
    const a = points[0]!;
    const b = points[1]!;
    return {
      midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.hypot(a.x - b.x, a.y - b.y),
    };
  };
  const baseline = () => {
    const p = pair();
    return p
      ? { ...p, world: viewport.screenToWorld(p.midpoint), scale: viewport.getViewport().scale }
      : undefined;
  };
  const down = (event: PointerEvent) => {
    if (isTextTarget(event.target)) return;
    element.focus({ preventScroll: true });
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, screenPoint(event));
      if (touches.size >= 2) {
        touchGesture = true;
        begin();
        touches.forEach((_, id) => capture(id));
        pinch = baseline();
        stop(event);
      }
      return;
    }
    if (event.button === 1 || (event.button === 0 && (space || options.tool === 'hand'))) {
      pan = { id: event.pointerId, point: screenPoint(event) };
      capture(event.pointerId);
      begin();
      stop(event);
    }
  };
  const move = (event: PointerEvent) => {
    if (touches.has(event.pointerId)) {
      touches.set(event.pointerId, screenPoint(event));
      if (!touchGesture) return;
      const next = pair();
      if (next && pinch) {
        // Absolute gesture baseline avoids scale drift when intermediate per-finger
        // pointer events briefly hit a zoom clamp during a two-finger translation.
        if (pinch.distance > 0 && next.distance > 0) {
          const scale = Math.max(
            MIN_ZOOM,
            Math.min(MAX_ZOOM, (pinch.scale * next.distance) / pinch.distance),
          );
          viewport.setViewport({
            x: next.midpoint.x - pinch.world.x * scale,
            y: next.midpoint.y - pinch.world.y * scale,
            scale,
          });
        } else pinch = baseline();
      }
      stop(event);
      return;
    }
    if (pan?.id !== event.pointerId) return;
    const point = screenPoint(event);
    viewport.panBy({ x: point.x - pan.point.x, y: point.y - pan.point.y });
    pan.point = point;
    stop(event);
  };
  const end = (event: PointerEvent) => {
    const handled = pan?.id === event.pointerId || (touchGesture && touches.has(event.pointerId));
    if (pan?.id === event.pointerId) pan = undefined;
    touches.delete(event.pointerId);
    pinch = baseline();
    release(event.pointerId);
    if (!touches.size) touchGesture = false;
    if (!pan && touches.size < 2) options.onPanningChange?.(false);
    if (handled) stop(event);
  };
  const lost = (event: PointerEvent) => {
    captures.delete(event.pointerId);
    if (pan?.id === event.pointerId) {
      pan = undefined;
      options.onPanningChange?.(false);
    }
    if (touches.delete(event.pointerId)) {
      pinch = baseline();
      if (!touches.size) touchGesture = false;
    }
  };
  const clear = () => {
    pan = undefined;
    touches.clear();
    pinch = undefined;
    touchGesture = false;
    space = false;
    for (const id of [...captures]) release(id);
    options.onPanningChange?.(false);
    options.onSpaceChange?.(false);
  };
  const wheel = (event: WheelEvent) => {
    if (isTextTarget(event.target)) return;
    stop(event);
    options.onNavigationStart?.();
    const delta = normalizedWheel(event, element.clientHeight);
    if (event.ctrlKey || event.metaKey)
      viewport.zoomAt(
        screenPoint(event),
        viewport.getViewport().scale *
          Math.exp(-Math.max(-1_000, Math.min(1_000, delta.y)) * 0.002),
      );
    else viewport.panBy({ x: -delta.x, y: -delta.y });
  };
  const keydown = (event: KeyboardEvent) => {
    if (
      event.code !== 'Space' ||
      isTextTarget(event.target) ||
      !element.contains(document.activeElement)
    )
      return;
    event.preventDefault();
    space = true;
    options.onSpaceChange?.(true);
  };
  const keyup = (event: KeyboardEvent) => {
    if (event.code === 'Space') {
      space = false;
      options.onSpaceChange?.(false);
    }
  };
  const focusout = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) clear();
  };
  const contextmenu = (event: Event) => {
    if (options.tool === 'hand' || pan) event.preventDefault();
  };
  element.addEventListener('pointerdown', down, true);
  element.addEventListener('pointermove', move, true);
  element.addEventListener('pointerup', end, true);
  element.addEventListener('pointercancel', end, true);
  element.addEventListener('lostpointercapture', lost);
  element.addEventListener('wheel', wheel, { passive: false });
  element.addEventListener('keydown', keydown);
  element.addEventListener('keyup', keyup);
  element.addEventListener('focusout', focusout);
  element.addEventListener('contextmenu', contextmenu);
  window.addEventListener('blur', clear);
  return () => {
    element.removeEventListener('pointerdown', down, true);
    element.removeEventListener('pointermove', move, true);
    element.removeEventListener('pointerup', end, true);
    element.removeEventListener('pointercancel', end, true);
    element.removeEventListener('lostpointercapture', lost);
    element.removeEventListener('wheel', wheel);
    element.removeEventListener('keydown', keydown);
    element.removeEventListener('keyup', keyup);
    element.removeEventListener('focusout', focusout);
    element.removeEventListener('contextmenu', contextmenu);
    window.removeEventListener('blur', clear);
    clear();
  };
}
