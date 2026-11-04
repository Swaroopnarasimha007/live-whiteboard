import { createElement, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Whiteboard } from '../../src/board';
import { ViewportController } from '../../src/board/viewport';
import { createSceneStore } from '../../src/scene';
import { createLayoutEngine, prepareLayoutFonts } from '../../src/layout';
import { createStreamConsumer } from '../../src/stream';
import { HttpGenerationTransport } from '../../src/stream/backend/transport';
import { buildGenerationRequest } from '../../src/context';
import type { GenerationTransport } from '../../src/contracts';

export async function measureDraws() {
  await prepareLayoutFonts();
  const base = 'http://127.0.0.1:8024';
  const identity = (await (
    await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  ).json()) as { sessionId: string };
  const store = createSceneStore({ documentId: 'b4-draw', layout: createLayoutEngine() });
  const viewport = new ViewportController({ reducedMotion: true });
  const receipt = new Map<number, number>();
  const pending = new Map<number, number>();
  const samples: number[] = [];
  let beforeTerminal = false,
    terminal = false,
    drawCount = 0;
  const source = new HttpGenerationTransport(base);
  const transport: GenerationTransport = {
    async *generate(request, signal) {
      terminal = false;
      for await (const event of source.generate(request, signal)) {
        if (event.event === 'operation') receipt.set(event.sequence, performance.now());
        if (event.event === 'completed') terminal = true;
        yield event;
      }
    },
  };
  const consumer = createStreamConsumer({
    store,
    onOperation: ({ sequence, result }) => {
      if (result.status === 'applied') pending.set(result.revision, receipt.get(sequence)!);
    },
  });
  function Board() {
    const scene = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return createElement(Whiteboard, {
      scene,
      viewport,
      ariaLabel: 'B4 measured canvas',
      onDraw: ({ revision, time }) => {
        drawCount++;
        for (const [rev, arrived] of pending)
          if (rev <= revision) {
            samples.push(time - arrived);
            pending.delete(rev);
            if (!terminal) beforeTerminal = true;
          }
      },
    });
  }
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:1100px;height:650px;background:white';
  document.body.replaceChildren(host);
  const root = createRoot(host);
  root.render(createElement(Board));
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    for (let i = 0; i < 5; i++) {
      const request = buildGenerationRequest({
        scene: store.getSnapshot(),
        sessionId: identity.sessionId,
        sessionEpoch: 0,
        requestId: `draw${i}`,
        activeSectionId: null,
        selectedIds: [],
        viewport: viewport.getSnapshot().viewport,
        visibleWorldBounds: viewport.getVisibleWorldBounds(),
        interactionInProgress: false,
        transcript: {
          segmentIds: [`draw${i}`],
          text: 'new topic browser server database',
          startMs: 0,
          endMs: 1000,
        },
      });
      const result = await consumer.consume(request, transport);
      if (result.phase !== 'completed') throw new Error(JSON.stringify(result));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ordered = [...samples].sort((a, b) => a - b);
    return {
      clock:
        'Browser performance.now only; HTTP completed operation receipt to actual Konva onDraw callback',
      completeOperationToKonvaDrawMs: {
        samples: samples.length,
        p50: ordered[Math.floor(ordered.length * 0.5)],
        p95: ordered[Math.floor(ordered.length * 0.95)],
        max: ordered.at(-1),
      },
      rawMs: samples,
      drawCount,
      beforeTerminal,
      pending: pending.size,
      workload:
        '5 sequential real HTTP mock requests, 30 operations, 300ms fixture pauses; empty initial board',
      limitation:
        'Headless actual Konva draw callbacks; no physical-screen presentation or remote provider latency claim. Concurrent implementation chats present.',
    };
  } finally {
    root.unmount();
    consumer.dispose();
    store.dispose();
    viewport.dispose();
    await fetch(`${base}/api/v1/sessions/${identity.sessionId}?sessionEpoch=0`, {
      method: 'DELETE',
    });
  }
}
