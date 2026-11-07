import type { Box, Point, Scene, Section, Viewport } from '../contracts';
import { getWorldBounds, screenToWorld, worldToScreen } from '../layout';

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 4;
export interface BoardSize {
  width: number;
  height: number;
}
export interface CameraOptions {
  manual?: boolean;
  animate?: boolean;
}
export interface AnimationClock {
  now(): number;
  request(callback: (time: number) => void): number;
  cancel(id: number): void;
}
export interface ViewportSnapshot {
  viewport: Viewport;
  size: BoardSize;
  followLive: boolean;
  liveSectionId: string | null;
  anchorSectionId: string | null;
}
export interface ViewportOptions {
  initialViewport?: Viewport;
  reducedMotion?: boolean;
  animationMs?: number;
  clock?: AnimationClock;
  onAnchorSectionChange?: (id: string | null) => void;
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const sameCamera = (a: Viewport, b: Viewport) => a.x === b.x && a.y === b.y && a.scale === b.scale;
const finitePoint = (p: Point) => {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y))
    throw new Error('Camera point must be finite');
};
export function unionBounds(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  return {
    x: left,
    y: top,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - left,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - top,
  };
}

/** Camera/UI state only. This class cannot dispatch or mutate a canonical scene. */
export class ViewportController {
  private snapshot: ViewportSnapshot;
  private readonly options: ViewportOptions;
  private readonly listeners = new Set<() => void>();
  private scene: Scene | undefined;
  private reducedMotion: boolean;
  private clock: AnimationClock | undefined;
  private frame: number | undefined;
  private animationTarget: Viewport | undefined;
  private deferredFit: { box: Box; options: CameraOptions } | undefined;
  private disposed = false;
  private preserveAnchor = false;

  constructor(options: ViewportOptions = {}) {
    this.options = options;
    const initial = options.initialViewport ?? { x: 0, y: 0, scale: 1 };
    finitePoint(initial);
    if (!Number.isFinite(initial.scale) || initial.scale <= 0)
      throw new Error('Invalid initial zoom');
    if (
      options.animationMs !== undefined &&
      (!Number.isFinite(options.animationMs) || options.animationMs < 0)
    )
      throw new Error('Invalid animation duration');
    this.snapshot = Object.freeze({
      viewport: Object.freeze({ ...initial, scale: clamp(initial.scale, MIN_ZOOM, MAX_ZOOM) }),
      size: Object.freeze({ width: 0, height: 0 }),
      followLive: true,
      liveSectionId: null,
      anchorSectionId: null,
    });
    this.reducedMotion = options.reducedMotion ?? false;
    this.clock =
      options.clock ??
      (typeof requestAnimationFrame === 'function'
        ? {
            now: () => performance.now(),
            request: (cb) => requestAnimationFrame(cb),
            cancel: (id) => cancelAnimationFrame(id),
          }
        : undefined);
  }
  getSnapshot = () => this.snapshot;
  getViewport = () => this.snapshot.viewport;
  subscribe = (listener: () => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<ViewportSnapshot>) {
    if (this.disposed) return;
    const next = { ...this.snapshot, ...patch };
    if (patch.viewport) next.viewport = Object.freeze({ ...patch.viewport });
    if (patch.size) next.size = Object.freeze({ ...patch.size });
    const center = screenToWorld(
      { x: next.size.width / 2, y: next.size.height / 2 },
      next.viewport,
    );
    const sections = this.scene ? Object.values(this.scene.sections) : [];
    const visible = this.getVisibleWorldBounds(0, next.viewport, next.size);
    const candidates = sections.filter((s) => {
      const b = getWorldBounds(s.bounds, s);
      return (
        b.x <= visible.x + visible.width &&
        b.x + b.width >= visible.x &&
        b.y <= visible.y + visible.height &&
        b.y + b.height >= visible.y
      );
    });
    const distance = (s: Section) => {
      const b = getWorldBounds(s.bounds, s);
      return Math.hypot(
        Math.max(b.x - center.x, 0, center.x - b.x - b.width),
        Math.max(b.y - center.y, 0, center.y - b.y - b.height),
      );
    };
    next.anchorSectionId = this.preserveAnchor
      ? this.snapshot.anchorSectionId
      : (candidates.sort((a, b) => distance(a) - distance(b) || a.order - b.order)[0]?.id ?? null);
    const anchorChanged = next.anchorSectionId !== this.snapshot.anchorSectionId;
    this.snapshot = Object.freeze(next);
    if (anchorChanged) this.options.onAnchorSectionChange?.(next.anchorSectionId);
    for (const listener of this.listeners) listener();
  }
  private cancelAnimation() {
    if (this.frame !== undefined) this.clock?.cancel(this.frame);
    this.frame = undefined;
    this.animationTarget = undefined;
  }
  private move(target: Viewport, options: CameraOptions = {}) {
    if (this.disposed) return;
    finitePoint(target);
    if (!Number.isFinite(target.scale) || target.scale <= 0)
      throw new Error('Invalid camera scale');
    target = { ...target, scale: clamp(target.scale, MIN_ZOOM, MAX_ZOOM) };
    this.cancelAnimation();
    if (options.manual !== false) {
      this.deferredFit = undefined;
      if (this.snapshot.followLive) this.publish({ followLive: false });
    }
    const duration = this.options.animationMs ?? 180;
    if (
      !options.animate ||
      this.reducedMotion ||
      !this.clock ||
      duration === 0 ||
      sameCamera(target, this.snapshot.viewport)
    ) {
      this.publish({ viewport: target });
      return;
    }
    const start = this.snapshot.viewport;
    const started = this.clock.now();
    const clock = this.clock;
    this.animationTarget = target;
    const tick = (time: number) => {
      if (this.disposed || this.animationTarget !== target) return;
      const progress = clamp((time - started) / duration, 0, 1);
      const eased = 1 - (1 - progress) ** 3;
      this.publish({
        viewport: {
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
          scale: start.scale + (target.scale - start.scale) * eased,
        },
      });
      if (this.animationTarget !== target) return;
      if (progress < 1) this.frame = clock.request(tick);
      else {
        this.frame = undefined;
        this.animationTarget = undefined;
      }
    };
    this.frame = clock.request(tick);
  }
  setSize(size: BoardSize) {
    if (![size.width, size.height].every((n) => Number.isFinite(n) && n >= 0))
      throw new Error('Invalid board size');
    if (
      this.disposed ||
      (size.width === this.snapshot.size.width && size.height === this.snapshot.size.height)
    )
      return;
    this.publish({ size });
    if (size.width > 0 && size.height > 0 && this.deferredFit) {
      const pending = this.deferredFit;
      this.deferredFit = undefined;
      this.fitBounds(pending.box, pending.options);
    }
  }
  setReducedMotion(value: boolean) {
    this.reducedMotion = value;
    if (value && this.animationTarget) this.move(this.animationTarget, { manual: false });
  }
  setViewport(viewport: Viewport, options: CameraOptions = {}) {
    this.move(viewport, options);
  }
  panBy(delta: Point, options: CameraOptions = {}) {
    finitePoint(delta);
    if (delta.x === 0 && delta.y === 0) return;
    const current = this.snapshot.viewport;
    this.move({ ...current, x: current.x + delta.x, y: current.y + delta.y }, options);
  }
  zoomAt(screen: Point, scale: number, options: CameraOptions = {}) {
    finitePoint(screen);
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid requested zoom');
    const world = this.screenToWorld(screen);
    const next = clamp(scale, MIN_ZOOM, MAX_ZOOM);
    this.move({ x: screen.x - world.x * next, y: screen.y - world.y * next, scale: next }, options);
  }
  zoomBy(factor: number, options: CameraOptions = {}) {
    this.zoomAt(
      { x: this.snapshot.size.width / 2, y: this.snapshot.size.height / 2 },
      this.snapshot.viewport.scale * factor,
      options,
    );
  }
  resetZoom(options: CameraOptions = {}) {
    this.zoomAt({ x: this.snapshot.size.width / 2, y: this.snapshot.size.height / 2 }, 1, options);
  }
  screenToWorld(screen: Point) {
    return screenToWorld(screen, this.snapshot.viewport);
  }
  getVisibleWorldBounds(
    overscanPx = 0,
    viewport = this.snapshot.viewport,
    size = this.snapshot.size,
  ): Box {
    const topLeft = screenToWorld({ x: -overscanPx, y: -overscanPx }, viewport);
    return {
      ...topLeft,
      width: (size.width + 2 * overscanPx) / viewport.scale,
      height: (size.height + 2 * overscanPx) / viewport.scale,
    };
  }
  fitBounds(box: Box, options: CameraOptions = {}) {
    if (
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.width < 0 ||
      box.height < 0
    )
      throw new Error('Invalid fit bounds');
    const { width, height } = this.snapshot.size;
    if (!width || !height) {
      this.deferredFit = { box: { ...box }, options };
      return;
    }
    const padding = Math.min(48, width / 5, height / 5);
    const scale = clamp(
      Math.min(
        (width - 2 * padding) / Math.max(1, box.width),
        (height - 2 * padding) / Math.max(1, box.height),
      ),
      MIN_ZOOM,
      1,
    );
    this.move(
      {
        x: width / 2 - (box.x + box.width / 2) * scale,
        y: height / 2 - (box.y + box.height / 2) * scale,
        scale,
      },
      options,
    );
  }
  fitSection(section: string | Section, options: CameraOptions = {}) {
    const target = typeof section === 'string' ? this.scene?.sections[section] : section;
    if (target && typeof target === 'object')
      this.fitBounds(getWorldBounds(target.bounds, target), options);
  }
  fitBoard(options: CameraOptions = {}) {
    const box = unionBounds(
      Object.values(this.scene?.sections ?? {}).map((s) => getWorldBounds(s.bounds, s)),
    );
    if (box) this.fitBounds(box, options);
  }
  suspendFollow() {
    this.cancelAnimation();
    this.deferredFit = undefined;
    if (this.snapshot.followLive) this.publish({ followLive: false });
  }
  resumeLive() {
    if (this.disposed) return;
    this.publish({ followLive: true });
    if (this.snapshot.liveSectionId)
      this.fitSection(this.snapshot.liveSectionId, { manual: false, animate: true });
  }
  compensateAnchor(delta: Point) {
    finitePoint(delta);
    const current = this.snapshot.viewport;
    this.preserveAnchor = true;
    try {
      this.move(
        {
          ...current,
          x: current.x - delta.x * current.scale,
          y: current.y - delta.y * current.scale,
        },
        { manual: false },
      );
    } finally {
      this.preserveAnchor = false;
    }
  }
  private keepVisible(box: Box) {
    const viewport = this.animationTarget ?? this.snapshot.viewport;
    const start = worldToScreen(box, viewport);
    const { width, height } = this.snapshot.size;
    if (!width || !height) return;
    const shift = (start: number, length: number, size: number) => {
      const margin = Math.min(80, size / 4);
      const end = start + length;
      if (length > size - 2 * margin && start <= margin && end >= size - margin) return 0;
      return start < margin ? margin - start : end > size - margin ? size - margin - end : 0;
    };
    const dx = shift(start.x, box.width * viewport.scale, width);
    const dy = shift(start.y, box.height * viewport.scale, height);
    if (dx || dy)
      this.move(
        { ...viewport, x: viewport.x + dx, y: viewport.y + dy },
        { manual: false, animate: true },
      );
  }
  observeScene(scene: Scene, liveSectionId?: string | null) {
    if (
      this.disposed ||
      (scene === this.scene &&
        (liveSectionId === undefined || liveSectionId === this.snapshot.liveSectionId))
    )
      return;
    let previous = this.scene;
    const reset =
      previous && (previous.documentId !== scene.documentId || scene.revision < previous.revision);
    if (reset) {
      this.cancelAnimation();
      this.deferredFit = undefined;
      previous = undefined;
    }
    this.scene = scene;
    const newSections = Object.values(scene.sections)
      .filter((s) => s.id.startsWith('g_') && !previous?.sections[s.id])
      .sort((a, b) => a.order - b.order);
    const generatedNodes = Object.values(scene.nodes).filter(
      (n) =>
        n.source === 'generated' &&
        n.lastManualRevision !== scene.revision &&
        n.revision !== previous?.nodes[n.id]?.revision,
    );
    const generatedEdges = Object.values(scene.edges).filter(
      (e) =>
        e.source === 'generated' &&
        e.lastManualRevision !== scene.revision &&
        e.revision !== previous?.edges[e.id]?.revision,
    );
    const oldLive = reset ? null : this.snapshot.liveSectionId;
    const inferred =
      newSections.at(-1)?.id ??
      generatedNodes.at(-1)?.sectionId ??
      generatedEdges.at(-1)?.sectionId ??
      (oldLive && scene.sections[oldLive] ? oldLive : null) ??
      null;
    const candidate = liveSectionId === undefined ? inferred : liveSectionId;
    const latest = candidate && Object.hasOwn(scene.sections, candidate) ? candidate : null;
    this.publish({ liveSectionId: latest, ...(reset ? { followLive: true } : {}) });
    if (reset && !Object.keys(scene.sections).length) {
      this.move({ x: 0, y: 0, scale: 1 }, { manual: false });
      return;
    }
    if (!this.snapshot.followLive || !latest) return;
    if (newSections.some((s) => s.id === latest) || latest !== oldLive) {
      this.fitSection(latest, { manual: false, animate: true });
      return;
    }
    const bounds = generatedNodes
      .filter((n) => n.sectionId === latest)
      .map((n) => getWorldBounds(n, scene.sections[n.sectionId]!));
    const box = unionBounds(bounds);
    if (box) this.keepVisible(box);
  }
  dispose() {
    if (this.disposed) return;
    this.cancelAnimation();
    this.disposed = true;
    this.listeners.clear();
    this.scene = undefined;
    this.deferredFit = undefined;
  }
}
