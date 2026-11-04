import { createElement, createRef, type KeyboardEvent as ReactKeyEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Scene } from '../contracts';
import { createSceneStore } from '../scene';
import { createLayoutEngine, prepareLayoutFonts } from '../layout';
import { ViewportController } from '../board/viewport';
import { fixtureScene } from '../board/browserHarness';
import type { WhiteboardHandle } from '../board/types';
import { createEditorController } from './controller';
import { EditorSurface } from './EditorSurface';
import { ToolPalette, SelectionProperties } from './controls';
import { handleEditorKeyDown } from './shortcuts';

/** Owned browser-test composition only; not exported from the editor barrel. */
export async function mountEditorHarness(scene: Scene = fixtureScene(2, false)) {
  await prepareLayoutFonts();
  const layout = createLayoutEngine();
  const viewport = new ViewportController({
    reducedMotion: true,
    onAnchorSectionChange: (id) => layout.setAnchorSection(id),
  });
  const store = createSceneStore({
    documentId: 'editor-harness',
    initialScene: scene,
    layout,
    onLayout: ({ anchorDelta }) => {
      if (anchorDelta) viewport.compensateAnchor(anchorDelta);
    },
  });
  const editor = createEditorController(store, viewport);
  const board = createRef<WhiteboardHandle>();
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:0;top:0;width:1100px;height:700px;z-index:9999;background:#fff';
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    createElement(
      'main',
      {
        style: { display: 'grid', gridTemplateColumns: '220px 1fr', width: '100%', height: '100%' },
        onKeyDown: (event: ReactKeyEvent) => handleEditorKeyDown(event.nativeEvent, editor),
      },
      createElement(
        'aside',
        { className: 'renderer-sidebar', 'aria-label': 'Editor harness properties' },
        createElement(ToolPalette, { editor }),
        createElement(SelectionProperties, { editor }),
      ),
      createElement(EditorSurface, {
        editor,
        store,
        viewport,
        ref: board,
        ariaLabel: 'Editor harness canvas',
      }),
    ),
  );
  return {
    host,
    root,
    editor,
    store,
    viewport,
    board,
    unmount() {
      root.unmount();
      editor.dispose();
      viewport.dispose();
      store.dispose();
      host.remove();
    },
  };
}
export let activeHarness: Awaited<ReturnType<typeof mountEditorHarness>> | undefined;
export async function startHarness(count = 2, allShapes = false) {
  activeHarness?.unmount();
  activeHarness = await mountEditorHarness(fixtureScene(count, allShapes));
}
export function stopHarness() {
  activeHarness?.unmount();
  activeHarness = undefined;
}
