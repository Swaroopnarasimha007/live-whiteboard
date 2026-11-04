import { adaptRawFixtureTransport } from '../../src/stream/rawFixture';
import { createElement, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { createSceneStore } from '../../src/scene';
import { Whiteboard } from '../../src/board';
import { ViewportController } from '../../src/board/viewport';
import {
  createLayoutEngine,
  prepareLayoutFonts,
  createEdgeRouter,
  routeEdge,
  resolvePlacement,
} from '../../src/layout';
import { createStreamConsumer, createNdjsonDecoder } from '../../src/stream';
import { operationSchema, type GenerationTransport } from '../../src/contracts';
import { buildGenerationRequest } from '../../src/context';
import { performanceScene } from '../fixtures/protocol';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}
export async function runBenchmark() {
  await prepareLayoutFonts();
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;inset:0;width:1100px;height:600px;background:white;z-index:99999';
  document.body.replaceChildren(host);
  const initial = performanceScene(500, 1);
  const adapter = createLayoutEngine();
  const layoutTimes: number[] = [];
  const dispatchTimes: number[] = [];
  const arrival = new Map<number, number>();
  const commits = new Map<number, number>();
  const draws: number[] = [];
  const commitDraw: number[] = [];
  const store = createSceneStore({
    documentId: 'performance',
    initialScene: initial,
    layout: {
      layoutTransaction(input) {
        const t = performance.now();
        const out = adapter.layoutTransaction(input);
        layoutTimes.push(performance.now() - t);
        return out;
      },
    },
  });
  const viewport = new ViewportController({ reducedMotion: true });
  const pending = new Map<number, number>();
  let lastDraw = 0;
  let viewDraw = performance.now();
  store.subscribe((scene) => commits.set(scene.revision, performance.now()));
  const dispatch = store.dispatch;
  store.dispatch = (operation, meta) => {
    const t = performance.now();
    const result = dispatch(operation, meta);
    dispatchTimes.push(performance.now() - t);
    return result;
  };
  const consumer = createStreamConsumer({
    store,
    onOperation: ({ sequence, result }) => {
      if (result.status === 'applied') pending.set(result.revision, arrival.get(sequence)!);
    },
  });
  function Board() {
    const scene = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return createElement(Whiteboard, {
      scene,
      viewport,
      ariaLabel: 'Performance canvas',
      onDraw: ({ revision, time }) => {
        lastDraw = revision;
        viewDraw = time;
        for (const [rev, received] of pending)
          if (rev <= revision) {
            draws.push(time - received);
            commitDraw.push(time - (commits.get(rev) ?? time));
            pending.delete(rev);
          }
      },
    });
  }
  const root = createRoot(host);
  root.render(createElement(Board));
  await delay(120);
  viewport.fitSection('g_s0', { manual: false });
  await delay(100);
  const visible500 = Number(
    host.querySelector('[role="application"]')?.getAttribute('data-visible-nodes'),
  );
  const operations = Array.from({ length: 90 }, (_, i) =>
    operationSchema.parse({ op: 'node.update', id: `g_n${i}`, set: { label: `Update ${i}` } }),
  );
  const encoded = operations.map((op) => new TextEncoder().encode(JSON.stringify(op) + '\n'));
  let decoderRecords = 0;
  const decoder = createNdjsonDecoder({ onRecord: () => decoderRecords++ });
  let t = performance.now();
  for (const bytes of encoded)
    for (let o = 0; o < bytes.length; o += 3) decoder.push(bytes.subarray(o, o + 3));
  decoder.finish();
  const decodeOnlyMs = performance.now() - t;
  t = performance.now();
  for (const op of operations) operationSchema.parse(op);
  const validationOnlyMs = performance.now() - t;
  const transport: GenerationTransport = adaptRawFixtureTransport({
    async *generate() {
      const start = performance.now();
      for (let i = 0; i < encoded.length; i++) {
        await delay(Math.max(0, start + (i * 1000) / 30 - performance.now()));
        arrival.set(i + 2, performance.now());
        performance.mark(`operation-${i}-complete`);
        yield encoded[i]!;
      }
    },
  });
  const request = buildGenerationRequest({
    scene: store.getSnapshot(),
    sessionEpoch: 0,
    sessionId: 's_benchmark',
    requestId: 'benchmark',
    transcript: {
      segmentIds: ['benchmark'],
      text: 'Controlled 30 operations per second',
      startMs: 0,
      endMs: 3000,
    },
    viewport: viewport.getSnapshot().viewport,
    visibleWorldBounds: viewport.getVisibleWorldBounds(),
    selectedIds: [],
    activeSectionId: 'g_s0',
    interactionInProgress: false,
  });
  const streamStart = performance.now();
  const result = await consumer.consume(request, transport);
  await delay(100);
  const streamElapsedMs = performance.now() - streamStart;
  const router = createEdgeRouter();
  const scene = store.getSnapshot();
  const edge = {
    id: 'g_bench_edge',
    sectionId: 'g_s0',
    from: 'g_n0',
    to: 'g_n1',
    label: 'Benchmark',
    kind: 'arrow' as const,
    color: 'neutral' as const,
    source: 'generated' as const,
    locked: false,
    revision: 1,
    lastManualRevision: 0,
  };
  t = performance.now();
  for (let i = 0; i < 500; i++) routeEdge(edge, scene);
  const uncachedRoutingMs = performance.now() - t;
  t = performance.now();
  for (let i = 0; i < 500; i++) router.route(edge, scene);
  const cachedRoutingMs = performance.now() - t;
  t = performance.now();
  let collisionAttempts = 0;
  for (let i = 0; i < 500; i++)
    collisionAttempts += resolvePlacement({
      node: { ...scene.nodes.g_n0!, id: 'g_new' },
      nodes: Object.values(scene.nodes),
      source: 'generated',
      at: [0, 0],
    }).attempts;
  const collisionPlacementMs = performance.now() - t;
  const streamLastDraw = lastDraw;
  const large = performanceScene(5000, 50);
  if (store.importScene(JSON.stringify(large)).status !== 'applied')
    throw new Error('Large dataset import failed');
  await delay(120);
  const navigation: number[] = [];
  for (let i = 0; i < 50; i++) {
    t = performance.now();
    viewport.fitSection(`g_s${i}`, { manual: true });
    let guard = 0;
    while (viewDraw < t && guard++ < 20) await frame();
    navigation.push(viewDraw - t);
  }
  const visible5000 = Number(
    host.querySelector('[role="application"]')?.getAttribute('data-visible-nodes'),
  );
  const intervals: number[] = [];
  let previous = await frame();
  for (let i = 0; i < 120; i++) {
    viewport.panBy({ x: i % 2 ? 4 : -4, y: 0 }, { manual: true });
    const next = await frame();
    intervals.push(next - previous);
    previous = next;
  }
  const report = {
    browser: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    dpr: devicePixelRatio,
    canvas: { width: 1100, height: 600 },
    workload: {
      visibleDatasetNodes: 500,
      visible500,
      rate: 30,
      operations: 90,
      totalNavigationNodes: 5000,
      sections: 50,
      visible5000,
    },
    stream: {
      phase: result.phase,
      applied: result.stats.applied,
      elapsedMs: streamElapsedMs,
      completeOperationToKonvaDrawMs: summary(draws),
      commitToDrawMs: summary(commitDraw),
      dispatchIncludingLayoutMs: summary(dispatchTimes),
      layoutMs: summary(layoutTimes),
      decoderRecords,
      decodeOnlyMs,
      validationOnlyMs,
      lastDraw: streamLastDraw,
      pendingDraws: pending.size,
    },
    routing: { iterations: 500, uncachedRoutingMs, cachedRoutingMs },
    collision: { iterations: 500, collisionPlacementMs, collisionAttempts },
    navigation: {
      inputToDrawMs: summary(navigation),
      animationFrameIntervalsMs: summary(intervals),
      meanAnimationFrameFps: 1000 / (intervals.reduce((a, b) => a + b, 0) / intervals.length),
    },
    queueDelay:
      'Not included in transport benchmark; session acceptance tests cover queue grouping and separate age/latency.',
  };
  consumer.dispose();
  root.unmount();
  viewport.dispose();
  store.dispose();
  host.remove();
  return report;
}
