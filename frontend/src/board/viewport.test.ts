import { describe, expect, it, vi } from 'vitest';
import { createLayoutEngine, estimatedTextMeasurer, worldToScreen } from '../layout';
import { setup } from '../scene/test-helpers';
import { edge, node, scene, section } from '../layout/test-fixtures';
import { ViewportController, type AnimationClock } from './viewport';

function clock() {
  let now = 0;
  let id = 0;
  const frames = new Map<number, (time: number) => void>();
  const api: AnimationClock = {
    now: () => now,
    request: (cb) => {
      frames.set(++id, cb);
      return id;
    },
    cancel: (id) => {
      frames.delete(id);
    },
  };
  return {
    api,
    frames,
    advance: (ms: number) => {
      now += ms;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((cb) => cb(now));
    },
  };
}
describe('viewport state and follow behavior', () => {
  it('defaults to select-compatible 100% camera with live follow and immutable snapshots', () => {
    const controller = new ViewportController();
    expect(controller.getViewport()).toEqual({ x: 0, y: 0, scale: 1 });
    expect(controller.getSnapshot().followLive).toBe(true);
    expect(() => {
      controller.getViewport().x = 50;
    }).toThrow();
  });
  it.each([0.15, 0.5, 1, 2, 4])('zooms around the pointer with pan at scale %s', (scale) => {
    const controller = new ViewportController({ initialViewport: { x: -150, y: 80, scale } });
    const pointer = { x: 257, y: 193 };
    const before = controller.screenToWorld(pointer);
    controller.zoomAt(pointer, scale * 1.5);
    const after = controller.screenToWorld(pointer);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(controller.getSnapshot().followLive).toBe(false);
    expect(controller.getViewport().scale).toBeLessThanOrEqual(4);
  });
  it('fits bounds, sections and the board without exceeding readable zoom limits', () => {
    const controller = new ViewportController();
    controller.setSize({ width: 1_000, height: 700 });
    controller.observeScene(scene());
    controller.fitBoard();
    expect(controller.getViewport().scale).toBeLessThanOrEqual(1);
    expect(controller.getViewport().scale).toBeGreaterThanOrEqual(0.15);
    controller.zoomAt({ x: 0, y: 0 }, 4);
    controller.fitSection('g_s');
    expect(controller.getViewport().scale).toBe(1);
    controller.zoomBy(0.5);
    controller.resetZoom();
    expect(controller.getViewport().scale).toBe(1);
  });
  it('defers a fit until measured and preserves the scene camera on subsequent resizing', () => {
    const controller = new ViewportController();
    controller.fitBounds({ x: 500, y: 300, width: 200, height: 200 });
    controller.setSize({ width: 800, height: 600 });
    const before = controller.getViewport();
    expect(before.x).not.toBe(0);
    controller.setSize({ width: 1_200, height: 900 });
    expect(controller.getViewport()).toBe(before);
  });
  it('focuses a new generated section once, then only pans outside safe margins', () => {
    const controller = new ViewportController();
    controller.setSize({ width: 1_000, height: 700 });
    const board = scene([node()]);
    controller.observeScene(board);
    const fit = controller.getViewport();
    controller.observeScene(board);
    expect(controller.getViewport()).toBe(fit);
    const nearby = {
      ...board,
      revision: 2,
      nodes: { ...board.nodes, g_near: node({ id: 'g_near', x: 140, revision: 1 }) },
    };
    controller.observeScene(nearby);
    expect(controller.getViewport()).toBe(fit);
    const distant = {
      ...nearby,
      revision: 3,
      nodes: { ...nearby.nodes, g_far: node({ id: 'g_far', x: 2_200 }) },
    };
    controller.observeScene(distant);
    expect(controller.getViewport().x).toBeLessThan(fit.x);
    expect(controller.getViewport().scale).toBe(fit.scale);
  });
  it('manual pan suspends follow while newest generated topic remains independently tracked', () => {
    const controller = new ViewportController();
    controller.setSize({ width: 800, height: 600 });
    const first = scene([node()]);
    controller.observeScene(first);
    controller.panBy({ x: -200, y: 100 });
    const browsed = controller.getViewport();
    const next = {
      ...first,
      revision: 2,
      sections: {
        ...first.sections,
        g_s2: section({ id: 'g_s2', order: 1, origin: { x: 0, y: 1_000 } }),
      },
    };
    controller.observeScene(next);
    expect(controller.getViewport()).toBe(browsed);
    expect(controller.getSnapshot().liveSectionId).toBe('g_s2');
    controller.resumeLive();
    expect(controller.getSnapshot().followLive).toBe(true);
    expect(controller.getViewport().y).toBeLessThan(-500);
  });
  it('manual changes to generated nodes do not act as fresh generation or steal the view', () => {
    const controller = new ViewportController();
    controller.setSize({ width: 800, height: 600 });
    const board = scene([node()]);
    controller.observeScene(board);
    const before = controller.getViewport();
    controller.observeScene({
      ...board,
      revision: 2,
      nodes: { g_a: node({ x: 10_000, revision: 2, lastManualRevision: 2 }) },
    });
    expect(controller.getViewport()).toBe(before);
  });
  it('follows generated edits back to earlier topics while respecting paused following', () => {
    const controller = new ViewportController();
    controller.setSize({ width: 800, height: 600 });
    const board = scene(
      [node(), node({ id: 'g_b', sectionId: 'g_s2' })],
      [section(), section({ id: 'g_s2', order: 1, origin: { x: 0, y: 1_000 } })],
    );
    controller.observeScene(board);
    const before = controller.getViewport();
    const correction = {
      ...board,
      revision: 2,
      nodes: { ...board.nodes, g_a: node({ x: 2_000, revision: 2 }) },
    };
    controller.observeScene(correction);
    expect(controller.getSnapshot().liveSectionId).toBe('g_s');
    expect(controller.getViewport()).not.toBe(before);
    controller.panBy({ x: 100, y: 50 }, { manual: true });
    const paused = controller.getViewport();
    controller.observeScene({
      ...correction,
      revision: 3,
      nodes: { ...correction.nodes, g_b: node({ id: 'g_b', sectionId: 'g_s2', revision: 3 }) },
    });
    expect(controller.getSnapshot().liveSectionId).toBe('g_s2');
    expect(controller.getViewport()).toBe(paused);
    controller.resumeLive();
    expect(controller.getViewport()).not.toBe(paused);
  });
  it('live edges can identify a manual section without changing selection', () => {
    const manualSection = 'm_00000000-0000-4000-8000-000000000001';
    const controller = new ViewportController();
    controller.setSize({ width: 800, height: 600 });
    const board = scene(
      [node({ sectionId: manualSection }), node({ id: 'g_b', sectionId: manualSection, x: 300 })],
      [section({ id: manualSection })],
    );
    controller.observeScene(board);
    controller.observeScene({
      ...board,
      revision: 2,
      edges: { g_e: edge({ sectionId: manualSection }) },
    });
    expect(controller.getSnapshot().liveSectionId).toBe(manualSection);
  });
  it('compensates section reflow at current scale without changing follow state or documents', () => {
    const controller = new ViewportController({ initialViewport: { x: 70, y: -2_000, scale: 2 } });
    const original = controller.getViewport();
    const world = { x: 120, y: 1_100 };
    const before = worldToScreen(world, original);
    controller.compensateAnchor({ x: 10, y: 300 });
    expect(worldToScreen({ x: world.x + 10, y: world.y + 300 }, controller.getViewport())).toEqual(
      before,
    );
    expect(controller.getSnapshot().followLive).toBe(true);
  });
  it('animates with at most one frame and manual interaction interrupts immediately', () => {
    const timer = clock();
    const controller = new ViewportController({ clock: timer.api });
    controller.setSize({ width: 800, height: 600 });
    controller.setViewport({ x: -500, y: 200, scale: 2 }, { animate: true, manual: false });
    expect(timer.frames.size).toBe(1);
    timer.advance(60);
    expect(controller.getViewport().x).toBeLessThan(0);
    controller.panBy({ x: 25, y: 0 });
    const manual = controller.getViewport();
    expect(timer.frames.size).toBe(0);
    timer.advance(1_000);
    expect(controller.getViewport()).toBe(manual);
    controller.setViewport({ x: 1, y: 2, scale: 1 }, { animate: true });
    controller.setViewport({ x: 3, y: 4, scale: 2 }, { animate: true });
    expect(timer.frames.size).toBe(1);
    timer.advance(200);
    expect(controller.getViewport()).toEqual({ x: 3, y: 4, scale: 2 });
    expect(timer.frames.size).toBe(0);
  });
  it('honors reduced motion and cancels every scheduled frame on disposal', () => {
    const timer = clock();
    const controller = new ViewportController({ clock: timer.api, reducedMotion: true });
    controller.setViewport({ x: 20, y: 30, scale: 2 }, { animate: true });
    expect(timer.frames.size).toBe(0);
    expect(controller.getViewport().scale).toBe(2);
    controller.setReducedMotion(false);
    controller.setViewport({ x: 50, y: 70, scale: 3 }, { animate: true });
    expect(timer.frames.size).toBe(1);
    controller.dispose();
    expect(timer.frames.size).toBe(0);
    timer.advance(1_000);
    expect(controller.getViewport().scale).toBe(2);
  });
  it('does not create document revisions when navigating or following reflow', () => {
    const layout = createLayoutEngine({ measurer: estimatedTextMeasurer });
    const controller = new ViewportController({
      onAnchorSectionChange: (id) => layout.setAnchorSection(id),
    });
    controller.setSize({ width: 800, height: 600 });
    const { store, addSection, addNode } = setup({ layout });
    addSection();
    addNode();
    controller.observeScene(store.getSnapshot());
    const before = store.getSnapshot();
    controller.panBy({ x: 40, y: -30 });
    controller.zoomBy(2);
    controller.fitBoard();
    controller.resumeLive();
    expect(store.getSnapshot()).toBe(before);
  });
  it('notifies and unsubscribes predictably, rejecting invalid camera inputs', () => {
    const controller = new ViewportController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.panBy({ x: 1, y: 2 });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    const count = listener.mock.calls.length;
    controller.panBy({ x: 1, y: 2 });
    expect(listener).toHaveBeenCalledTimes(count);
    expect(() => controller.zoomAt({ x: 0, y: 0 }, 0)).toThrow();
    expect(() => controller.setSize({ width: NaN, height: 2 })).toThrow();
  });
});
