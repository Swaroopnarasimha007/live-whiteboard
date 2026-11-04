import { createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { Scene, Shape as NodeShape } from '../contracts';
import { Whiteboard } from './Whiteboard';
import { ViewportController } from './viewport';
import type { WhiteboardHandle, WhiteboardProps } from './types';

/** Browser-test fixture only; intentionally absent from public exports and app composition. */
export function fixtureScene(count = 6, allShapes = true): Scene {
  const scene: Scene = {
    schemaVersion: 1,
    documentId: 'board-test',
    revision: 1,
    nodes: {},
    edges: {},
    sections: {},
  };
  const types: NodeShape[] = ['rect', 'roundRect', 'circle', 'ellipse', 'diamond', 'text'];
  for (let index = 0; index < count; index++) {
    const sectionIndex = Math.floor(index / 100);
    const sectionId = `g_s${sectionIndex}`;
    scene.sections[sectionId] ??= {
      id: sectionId,
      title: `Section ${sectionIndex + 1}`,
      order: sectionIndex,
      origin: { x: 0, y: sectionIndex * 2_000 },
      bounds: { x: -32, y: -74, width: count <= 6 ? 640 : 1_900, height: count <= 6 ? 320 : 1_400 },
    };
    const type = allShapes ? types[index % types.length]! : 'rect';
    const id = `g_n${index}`;
    scene.nodes[id] = {
      id,
      sectionId,
      type,
      label: `${type} ${index}`,
      color: 'blue',
      source: 'generated',
      locked: false,
      revision: 1,
      lastManualRevision: 0,
      sizing: 'fixed',
      x: (index % (count <= 6 ? 3 : 10)) * 180,
      y: Math.floor((index % 100) / (count <= 6 ? 3 : 10)) * 120,
      width: type === 'circle' ? 88 : 120,
      height: type === 'circle' ? 88 : 64,
    };
  }
  if (count >= 2)
    scene.edges.g_e = {
      id: 'g_e',
      sectionId: 'g_s0',
      from: 'g_n0',
      to: 'g_n1',
      kind: 'arrow',
      label: 'Link',
      color: 'neutral',
      source: 'generated',
      locked: false,
      revision: 1,
      lastManualRevision: 0,
    };
  return scene;
}
export function mountBoardHarness(scene = fixtureScene()) {
  const container = document.createElement('div');
  container.style.cssText =
    'position:fixed;left:0;top:0;width:800px;height:600px;z-index:9999;background:white';
  document.body.appendChild(container);
  const root = createRoot(container);
  const controller = new ViewportController({ reducedMotion: true });
  const handle = createRef<WhiteboardHandle>();
  const events: { id: string; x: number; y: number }[] = [];
  let props: WhiteboardProps = {
    scene,
    viewport: controller,
    ariaLabel: 'Harness board',
    interactions: {
      onNodePointerDown: (id, event) => events.push({ id, x: event.world.x, y: event.world.y }),
    },
  };
  const render = () => root.render(createElement(Whiteboard, { ...props, ref: handle }));
  render();
  return {
    scene,
    controller,
    handle,
    events,
    container,
    update: (patch: Partial<WhiteboardProps>) => {
      props = { ...props, ...patch };
      render();
    },
    unmount: () => {
      root.unmount();
      controller.dispose();
      container.remove();
    },
  };
}
export let activeHarness: ReturnType<typeof mountBoardHarness> | undefined;
export function startHarness(count = 6, allShapes = true) {
  activeHarness?.unmount();
  activeHarness = mountBoardHarness(fixtureScene(count, allShapes));
}
export function stopHarness() {
  activeHarness?.unmount();
  activeHarness = undefined;
}
