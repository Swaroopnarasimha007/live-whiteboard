import type { GenerationRequest } from '../contracts';
import type { SceneStore } from '../scene';
import type { ViewportController } from '../board/viewport';
import type { EditorController } from '../editor/controller';
import { buildGenerationRequest, type ContextView } from '../context';
import { createStreamConsumer, MockGenerationTransport } from '../stream';

export function currentContextView(
  store: SceneStore,
  viewport: ViewportController,
  editor: EditorController,
): ContextView {
  const scene = store.getSnapshot();
  const camera = viewport.getSnapshot();
  const edit = editor.getSnapshot();
  const active = camera.liveSectionId ?? edit.activeSectionId;
  return {
    viewport: camera.viewport,
    visibleWorldBounds: viewport.getVisibleWorldBounds(),
    selectedIds: edit.selectedIds,
    activeSectionId:
      active && scene.sections[active]
        ? active
        : (Object.values(scene.sections)
            .sort((a, b) => a.order - b.order)
            .at(-1)?.id ?? null),
    interactionInProgress: edit.interactionInProgress,
  };
}
/** One-shot developer stream regression control. Normal demo input uses the session coordinator. */
export function createStreamPreview(
  store: SceneStore,
  viewport: ViewportController,
  editor: EditorController,
) {
  const consumer = createStreamConsumer({
    store,
    isInteractionInProgress: () => editor.getSnapshot().interactionInProgress,
  });
  let counter = 0;
  let lastRequest: GenerationRequest | null = null;
  const run = (retry = false) => {
    if (consumer.isActive() || editor.getSnapshot().interactionInProgress) return;
    if (!retry)
      lastRequest = buildGenerationRequest({
        ...currentContextView(store, viewport, editor),
        scene: store.getSnapshot(),
        sessionEpoch: store.getSessionEpoch(),
        sessionId: 'mock-preview',
        requestId: `mock_${store.getSessionEpoch() ? `e${store.getSessionEpoch()}_` : ''}r${++counter}`,
        transcript: {
          segmentIds: ['demo-browser', 'demo-server', 'demo-edge'],
          text: 'Browser sends a request to the server.',
          startMs: 0,
          endMs: 2000,
        },
      });
    if (lastRequest) return consumer.consume(lastRequest, new MockGenerationTransport(), { retry });
  };
  return {
    consumer,
    run,
    canRetry: () => !!lastRequest && lastRequest.sessionEpoch === store.getSessionEpoch(),
  };
}
