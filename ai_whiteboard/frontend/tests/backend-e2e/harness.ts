import { createElement, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Whiteboard } from '../../src/board';
import { createRendererRuntime } from '../../src/app/rendererRuntime';
import { RendererApp } from '../../src/app/RendererApp';
import { prepareLayoutFonts } from '../../src/layout';
import { buildGenerationRequest } from '../../src/context';
import { currentContextView } from '../../src/app/streamPreview';
import type { GenerationRequest, GenerationTransport } from '../../src/contracts';

export let runtime: ReturnType<typeof createRendererRuntime>;
export const observed: { nodes: number; inFlight: boolean; phase: string | undefined }[] = [];
export let activeCaptures = 0;
export let lastRequest: GenerationRequest;
let root: Root;
export const timing = {
  captureStartMs: 0,
  firstNodeDrawMs: null as number | null,
  finalTranscripts: [] as {
    id: string;
    receivedMs: number;
    endMs: number;
    lastRepresentedFrameToFinalMs: number | null;
  }[],
  generationSubmissions: [] as {
    requestId: string;
    sentMs: number;
    transcriptReceiptToSendMs: number[];
  }[],
  queueAgeMs: [] as number[],
};
export function mountMeasuredCanvas() {
  (document.body.firstElementChild as HTMLElement).style.cssText =
    'position:fixed;inset:0;width:1100px;height:650px;background:white';
  function Board() {
    const scene = useSyncExternalStore(
      runtime.store.subscribe,
      runtime.store.getSnapshot,
      runtime.store.getSnapshot,
    );
    return createElement(Whiteboard, {
      scene,
      viewport: runtime.viewport,
      ariaLabel: 'B4 speech measured canvas',
      onDraw: ({ time }) => {
        if (Object.keys(scene.nodes).length && timing.firstNodeDrawMs === null)
          timing.firstNodeDrawMs = time;
      },
    });
  }
  root.render(createElement(Board));
}
export function manualMoveAndLabel() {
  const node = Object.values(runtime.store.getSnapshot().nodes)[0]!;
  return runtime.store.dispatch(
    { op: 'node.update', id: node.id, set: { at: [413, 117], label: 'User edited label' } },
    {
      source: 'manual',
      sessionEpoch: runtime.store.getSessionEpoch(),
      transactionId: `manual_${crypto.randomUUID()}`,
    },
  );
}
export async function request(text: string, id: string, transport?: GenerationTransport) {
  const identity = await runtime.backend.ensure(runtime.store.getSessionEpoch());
  lastRequest = buildGenerationRequest({
    ...currentContextView(runtime.store, runtime.viewport, runtime.editor),
    scene: runtime.store.getSnapshot(),
    sessionEpoch: runtime.store.getSessionEpoch(),
    sessionId: identity.sessionId,
    requestId: id,
    transcript: { segmentIds: [id], text, startMs: 0, endMs: 1000 },
  });
  return runtime.stream.consumer.consume(lastRequest, transport ?? runtime.backend.transport);
}
/** Deterministic PCM fixture uses real WS/HTTP, without microphone permission or model credentials. */
export async function startHarness(pcmBase64?: string, baseUrl = 'http://127.0.0.1:8024') {
  await prepareLayoutFonts();
  runtime = createRendererRuntime({
    backend: {
      baseUrl,
      fetcher: async (input, init) => {
        if (String(input).endsWith('/api/v1/generations') && typeof init?.body === 'string') {
          const request = JSON.parse(init.body) as GenerationRequest;
          const now = performance.now();
          timing.generationSubmissions.push({
            requestId: request.requestId,
            sentMs: now,
            transcriptReceiptToSendMs: request.transcript.segmentIds.flatMap((id) => {
              const received = timing.finalTranscripts.find((event) => event.id === id);
              return received ? [now - received.receivedMs] : [];
            }),
          });
        }
        return fetch(input, init);
      },
      audioEnvironment: {
        secure: true,
        supported: true,
        connect: (url) => {
          const socket = new WebSocket(url);
          const sent: { endMs: number; time: number }[] = [];
          let bytes = 0;
          const send = socket.send.bind(socket);
          socket.send = (data) => {
            if (data instanceof ArrayBuffer) {
              bytes += data.byteLength;
              sent.push({ endMs: bytes / 32, time: performance.now() });
            }
            send(data);
          };
          socket.addEventListener('message', (event) => {
            if (typeof event.data !== 'string') return;
            const data = JSON.parse(event.data) as {
              type: string;
              isFinal?: boolean;
              id: string;
              endMs: number;
            };
            if (data.type === 'transcript' && data.isFinal) {
              const now = performance.now();
              const frame = sent.find((frame) => frame.endMs >= data.endMs);
              timing.finalTranscripts.push({
                id: data.id,
                receivedMs: now,
                endMs: data.endMs,
                lastRepresentedFrameToFinalMs: frame ? now - frame.time : null,
              });
            }
          });
          return socket;
        },
        capture: async (frame, _failure, frameMs, _max, signal) => {
          activeCaptures++;
          timing.captureStartMs = performance.now();
          const pcm = pcmBase64 ? Uint8Array.from(atob(pcmBase64), (c) => c.charCodeAt(0)) : null;
          let offset = 0;
          const timer = setInterval(() => {
            const size = 32 * frameMs;
            if (pcm && offset < pcm.length) {
              frame(pcm.slice(offset, offset + size).buffer);
              offset += size;
            } else frame(new ArrayBuffer(size));
          }, frameMs);
          let stopped = false;
          const stop = async () => {
            if (!stopped) {
              stopped = true;
              clearInterval(timer);
              activeCaptures--;
            }
          };
          signal.addEventListener(
            'abort',
            () => {
              void stop();
            },
            { once: true },
          );
          return { finish: stop, abort: stop, credit: () => {} };
        },
      },
    },
  });
  runtime.store.subscribe(() =>
    observed.push({
      nodes: Object.keys(runtime.store.getSnapshot().nodes).length,
      inFlight: runtime.session.getSnapshot().inFlight,
      phase: runtime.stream.consumer.getSnapshot().phase,
    }),
  );
  runtime.session.subscribe(() => timing.queueAgeMs.push(runtime.session.getSnapshot().queueAgeMs));
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  root = createRoot(host);
  root.render(createElement(RendererApp, { runtime }));
}
