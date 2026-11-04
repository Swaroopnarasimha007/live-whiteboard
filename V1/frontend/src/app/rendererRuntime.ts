import { BackendSessionBridge, type BackendBridgeOptions } from '../session/backend/bridge';
import { ViewportController } from '../board/viewport';
import { createLayoutEngine } from '../layout';
import { createSceneStore, type ScenePersistence } from '../scene';
import type { GenerationTransport } from '../contracts';
import type { SpeechSource } from '../audio';
import { createDocumentController } from './documentController';
import { createEditorController } from '../editor/controller';
import { createStreamPreview, currentContextView } from './streamPreview';
import { createSessionController } from '../session';
import { MockGenerationTransport } from '../stream';

/** Integration harness only: direct deterministic commands, no speech/transport simulation. */
export interface RendererRuntimeOptions {
  contextBudgetBytes?: number;
  persistence?: ScenePersistence;
  transport?: GenerationTransport;
  speech?: SpeechSource;
  backend?: BackendBridgeOptions;
}
export function createRendererRuntime(options: RendererRuntimeOptions = {}) {
  const layout = createLayoutEngine();
  const viewport = new ViewportController({
    onAnchorSectionChange: (id) => layout.setAnchorSection(id),
  });
  const store = createSceneStore({
    documentId: 'renderer-preview',
    layout,
    onLayout: ({ anchorDelta }) => {
      if (anchorDelta) viewport.compensateAnchor(anchorDelta);
    },
  });
  let request = 0;
  const editor = createEditorController(store, viewport);
  const stream = createStreamPreview(store, viewport, editor);
  const document = createDocumentController(store, options.persistence);
  const backend = new BackendSessionBridge(options.backend);
  const mockTransport = new MockGenerationTransport();
  const session = createSessionController({
    backend,
    store,
    consumer: stream.consumer,
    transport: options.transport ?? {
      generate: (request, signal) =>
        (request.sessionId.startsWith('bs_') ? backend.transport : mockTransport).generate(
          request,
          signal,
        ),
    },
    getContext: () => currentContextView(store, viewport, editor),
    subscribeInteraction: editor.subscribe,
    ...(options.contextBudgetBytes !== undefined
      ? { contextBudgetBytes: options.contextBudgetBytes }
      : {}),
    ...(options.speech ? { speech: options.speech } : {}),
  });
  const identity = () => {
    const epoch = store.getSessionEpoch();
    const requestId = `preview_${epoch ? `e${epoch}_` : ''}r${++request}`;
    return {
      prefix: `g_${requestId}_`,
      meta: {
        source: 'generated' as const,
        requestId,
        sequence: 0,
        baseRevision: store.getSnapshot().revision,
        sessionEpoch: store.getSessionEpoch(),
        transactionId: requestId,
      },
    };
  };
  const liveSection = () =>
    viewport.getSnapshot().liveSectionId ??
    Object.values(store.getSnapshot().sections)
      .sort((a, b) => a.order - b.order)
      .at(-1)?.id;
  return {
    store,
    viewport,
    editor,
    stream,
    session,
    backend,
    document,
    loadFixture() {
      const { prefix: p, meta } = identity();
      return store.dispatchTransaction(
        [
          { op: 'section.add', id: `${p}flow`, title: 'Request flow' },
          {
            op: 'node.add',
            id: `${p}browser`,
            section: `${p}flow`,
            type: 'rect',
            label: 'Browser',
            color: 'blue',
            at: [0, 0],
          },
          {
            op: 'node.add',
            id: `${p}server`,
            section: `${p}flow`,
            type: 'roundRect',
            label: 'API server',
            color: 'green',
            place: { rightOf: `${p}browser` },
          },
          {
            op: 'node.add',
            id: `${p}queue`,
            section: `${p}flow`,
            type: 'circle',
            label: 'Queue',
            color: 'orange',
            place: { rightOf: `${p}server` },
          },
          {
            op: 'node.add',
            id: `${p}cache`,
            section: `${p}flow`,
            type: 'ellipse',
            label: 'Cache',
            color: 'purple',
            place: { below: `${p}server` },
          },
          {
            op: 'node.add',
            id: `${p}decision`,
            section: `${p}flow`,
            type: 'diamond',
            label: 'Cached?',
            color: 'red',
            place: { below: `${p}browser` },
          },
          {
            op: 'node.add',
            id: `${p}note`,
            section: `${p}flow`,
            type: 'text',
            label: 'Explain the flow',
            place: { below: `${p}cache` },
          },
          {
            op: 'edge.add',
            id: `${p}request`,
            section: `${p}flow`,
            from: `${p}browser`,
            to: `${p}server`,
            label: 'Request',
          },
          {
            op: 'edge.add',
            id: `${p}job`,
            section: `${p}flow`,
            from: `${p}server`,
            to: `${p}queue`,
            label: 'Job',
          },
          {
            op: 'edge.add',
            id: `${p}lookup`,
            section: `${p}flow`,
            from: `${p}server`,
            to: `${p}cache`,
            label: 'Lookup',
          },
          {
            op: 'edge.add',
            id: `${p}branch`,
            section: `${p}flow`,
            from: `${p}browser`,
            to: `${p}decision`,
            kind: 'line',
          },
        ],
        meta,
      );
    },
    appendNode() {
      const section = liveSection();
      if (!section) return;
      const { prefix, meta } = identity();
      return store.dispatch(
        {
          op: 'node.add',
          id: `${prefix}distant`,
          section,
          type: 'rect',
          label: 'Distant fixture node',
          color: 'blue',
          at: [2_200, 0],
        },
        meta,
      );
    },
    appendTopic() {
      const { prefix, meta } = identity();
      return store.dispatchTransaction(
        [
          {
            op: 'section.add',
            id: `${prefix}topic`,
            title: `Topic ${Object.keys(store.getSnapshot().sections).length + 1}`,
          },
          {
            op: 'node.add',
            id: `${prefix}node`,
            section: `${prefix}topic`,
            type: 'ellipse',
            label: 'Next topic',
            color: 'purple',
          },
        ],
        meta,
      );
    },
    growFirstSection() {
      const first = Object.values(store.getSnapshot().nodes)[0];
      if (!first) return;
      const { meta } = identity();
      return store.dispatch(
        {
          op: 'node.update',
          id: first.id,
          set: { label: `${first.label}\nMore explanation\n`.repeat(12).slice(0, 500) },
        },
        meta,
      );
    },
    dispose() {
      void document.dispose();
      session.dispose();
      backend.dispose();
      stream.consumer.dispose();
      editor.dispose();
      viewport.dispose();
      store.dispose();
    },
  };
}
export type RendererRuntime = ReturnType<typeof createRendererRuntime>;
