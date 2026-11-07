import { adaptRawFixtureTransport } from '../stream/rawFixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationRequest, GenerationTransport } from '../contracts';
import type { SpeechEvent, SpeechSource, CaptureState } from '../audio';
import type { ContextView } from '../context';
import { setup, manualNodeId } from '../scene/test-helpers';
import { createStreamConsumer } from '../stream';
import { createSessionController } from './controller';
import { MicrophonePreviewSource } from '../audio';
import { createLayoutEngine } from '../layout';
import { fixedMeasurer } from '../layout/test-fixtures';

class Speech implements SpeechSource {
  emit: (e: SpeechEvent) => boolean = () => false;
  state: (s: CaptureState) => void = () => {};
  start(emit: Speech['emit'], state: Speech['state'] = () => {}) {
    this.emit = emit;
    this.state = state;
    state('recording');
  }
  pause() {
    this.state('paused');
  }
  resume() {
    this.state('recording');
  }
  stop() {
    this.state('idle');
  }
  dispose() {
    this.stop();
  }
}
const event = (id: string, text = id, isFinal = true, startMs = 0, endMs = 1000): SpeechEvent => ({
  id,
  text,
  isFinal,
  startMs,
  endMs,
});
let cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  cleanups.forEach((c) => c());
  cleanups = [];
  await Promise.resolve();
  vi.useRealTimers();
});
function harness(extra: Partial<Parameters<typeof createSessionController>[0]> = {}) {
  const scene = setup();
  const consumer = createStreamConsumer({ store: scene.store });
  const speech = new Speech();
  const requests: GenerationRequest[] = [];
  const transport: GenerationTransport = adaptRawFixtureTransport({
    async *generate(request) {
      requests.push(request);
      yield new TextEncoder().encode('');
    },
  });
  let view: ContextView = {
    viewport: { x: 0, y: 0, scale: 1 },
    visibleWorldBounds: { x: 0, y: 0, width: 800, height: 600 },
    selectedIds: [],
    activeSectionId: null,
    interactionInProgress: false,
  };
  let editorChanged = () => {};
  const session = createSessionController({
    store: scene.store,
    consumer,
    speech,
    transport,
    sessionId: 's_test',
    getContext: () => view,
    subscribeInteraction: (cb) => {
      editorChanged = cb;
      return () => {};
    },
    ...extra,
  });
  cleanups.push(() => {
    session.dispose();
    consumer.dispose();
    scene.store.dispose();
  });
  return {
    ...scene,
    consumer,
    session,
    speech,
    requests,
    setView(next: Partial<ContextView>) {
      view = { ...view, ...next };
      editorChanged();
    },
  };
}
describe('session scheduling and recovery', () => {
  it('sends committed collision repairs as context for the next transcript', async () => {
    const live = setup({ layout: createLayoutEngine({ measurer: fixedMeasurer }) });
    live.addSection();
    live.addNode();
    live.store.dispatch(
      { op: 'node.add', id: 'g_b', section: 'g_s', type: 'rect', label: 'Neighbor', at: [184, 0] },
      live.generated(),
    );
    const consumer = createStreamConsumer({ store: live.store });
    const requests: GenerationRequest[] = [];
    const transport = adaptRawFixtureTransport({
      async *generate(request) {
        requests.push(request);
        if (requests.length === 1)
          yield new TextEncoder().encode(
            JSON.stringify({ op: 'node.update', id: 'g_n', set: { at: [184, 0] } }) + '\n',
          );
      },
    });
    const { session } = harness({ store: live.store, consumer, transport });
    cleanups.push(() => {
      consumer.dispose();
      live.store.dispose();
    });
    session.ingest(event('t1', 'Move the source beside its neighbor'));
    await vi.advanceTimersByTimeAsync(500);
    const corrected = live.store.getSnapshot().nodes.g_n!;
    expect(corrected.x !== 184 || corrected.y !== 0).toBe(true);
    expect(live.store.getDiagnostics().some((d) => d.message.includes('Collision repaired'))).toBe(
      true,
    );
    session.ingest(event('t2', 'Continue with this board'));
    await vi.advanceTimersByTimeAsync(500);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.board.nodes.find((n) => n.id === 'g_n')).toMatchObject({
      x: corrected.x,
      y: corrected.y,
      width: corrected.width,
      height: corrected.height,
    });
    expect(requests[1]!.baseRevision).toBe(live.store.getSnapshot().revision);
  });
  it('ignores interim revisions, coalesces finals for 400 ms and sends unique IDs once', async () => {
    const { session, requests } = harness();
    session.ingest(event('t1', 'in', false));
    session.ingest(event('t1', 'interim', false));
    await vi.advanceTimersByTimeAsync(600);
    expect(requests).toHaveLength(0);
    session.ingest(event('t1', 'Final one'));
    await vi.advanceTimersByTimeAsync(250);
    session.ingest(event('t2', 'Final two'));
    await vi.advanceTimersByTimeAsync(149);
    expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.transcript).toMatchObject({
      segmentIds: ['t1', 't2'],
      text: 'Final one Final two',
    });
    expect(session.ingest(event('t1', 'Final one'))).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(requests).toHaveLength(1);
    expect(session.ingest(event('t1', 'Different final'))).toBe(false);
  });
  it('Send now flushes immediately and tracks queue age separately from request latency', async () => {
    const { session, requests } = harness();
    session.ingest(event('t1'));
    await vi.advanceTimersByTimeAsync(250);
    expect(session.getSnapshot().queueAgeMs).toBeGreaterThanOrEqual(250);
    expect(session.getSnapshot().modelLatencyMs).toBeNull();
    session.sendNow();
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(1);
    expect(session.getSnapshot().queueAgeMs).toBe(0);
    expect(session.getSnapshot().inspector?.bytes).toBeGreaterThan(0);
  });
  it('accumulates while streaming, then immediately sends fresh context after completion', async () => {
    const requests: GenerationRequest[] = [];
    let release = () => {};
    const transport: GenerationTransport = adaptRawFixtureTransport({
      async *generate(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield new TextEncoder().encode('{"op":"section.add","id":"topic","title":"Flow"}\n');
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
    });
    const { session, store } = harness({ transport });
    session.ingest(event('t1'));
    session.sendNow();
    await vi.advanceTimersByTimeAsync(10);
    expect(store.getSnapshot().revision).toBe(1);
    session.ingest(event('t2'));
    session.ingest(event('t3'));
    expect(requests).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.baseRevision).toBe(1);
    expect(requests[1]?.transcript.segmentIds).toEqual(['t2', 't3']);
    expect(requests[1]?.board.sections).toHaveLength(1);
  });
  it('waits through an editor interaction and snapshots the committed manual movement', async () => {
    const { session, store, manual, addSection, requests, setView } = harness();
    addSection();
    store.dispatch(
      { op: 'node.add', id: manualNodeId, section: 'g_s', type: 'rect', label: 'Manual' },
      manual(),
    );
    setView({ interactionInProgress: true, activeSectionId: 'g_s' });
    session.ingest(event('t1'));
    session.sendNow();
    await vi.advanceTimersByTimeAsync(500);
    expect(requests).toHaveLength(0);
    expect(
      store.dispatch(
        { op: 'node.resize', id: manualNodeId, at: [555, 0], width: 240, height: 60 },
        manual(),
      ).status,
    ).toBe('applied');
    setView({ interactionInProgress: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(requests[0]?.board.nodes[0]).toMatchObject({ x: 555, width: 240 });
  });
  it('context overflow pauses generation and retains all queued text', async () => {
    const { session, requests } = harness({ contextBudgetBytes: 50 });
    session.ingest(event('t1'));
    session.sendNow();
    await vi.advanceTimersByTimeAsync(500);
    expect(requests).toHaveLength(0);
    expect(session.getSnapshot()).toMatchObject({ generation: 'paused', queuedCharacters: 2 });
    expect(session.getSnapshot().queued[0]?.id).toBe('t1');
    expect(session.getSnapshot().message).toContain('Full context');
  });
  it('applies backpressure at the character limit and does not mark unaccepted speech as sent', async () => {
    const { session, requests } = harness({ maxQueuedCharacters: 5 });
    expect(session.ingest(event('t1', '1234'))).toBe(true);
    expect(session.ingest(event('t2', '56'))).toBe(false);
    expect(session.getSnapshot().capture).toBe('paused');
    expect(session.getSnapshot().queued).toHaveLength(1);
    session.sendNow();
    await vi.advanceTimersByTimeAsync(1);
    await session.resume();
    expect(session.ingest(event('t2', '56'))).toBe(true);
    session.sendNow();
    await vi.advanceTimersByTimeAsync(1);
    expect(requests.map((r) => r.transcript.segmentIds)).toEqual([['t1'], ['t2']]);
  });
  it('bounds queued audio duration using timestamps', () => {
    const { session } = harness();
    expect(session.ingest(event('t1', 'one', true, 0, 29000))).toBe(true);
    expect(session.ingest(event('t2', 'two', true, 29000, 31000))).toBe(false);
    expect(session.getSnapshot().queuedDurationMs).toBe(29000);
  });
  it('Pause lets an active request finish and retains queued segments until resume', async () => {
    let release = () => {};
    const requests: GenerationRequest[] = [];
    const transport: GenerationTransport = adaptRawFixtureTransport({
      async *generate(request) {
        requests.push(request);
        if (requests.length === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        yield new Uint8Array();
      },
    });
    const { session } = harness({ transport });
    session.ingest(event('t1'));
    session.sendNow();
    await vi.advanceTimersByTimeAsync(1);
    session.ingest(event('t2'));
    session.pause();
    release();
    await vi.advanceTimersByTimeAsync(500);
    expect(requests).toHaveLength(1);
    expect(session.getSnapshot().queued).toHaveLength(1);
    expect(session.ingest(event('t3'))).toBe(false);
    await session.resume();
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(2);
  });
  it('Stop preserves unsent text and a pinned partial request for explicit stable retry', async () => {
    const requests: GenerationRequest[] = [];
    const transport: GenerationTransport = adaptRawFixtureTransport({
      async *generate(request) {
        requests.push(request);
        yield new TextEncoder().encode('{"op":"section.add","id":"topic","title":"Flow"}\n');
        if (requests.length === 1) await new Promise(() => {});
      },
    });
    const { session, store } = harness({ transport });
    session.ingest(event('t1'));
    session.sendNow();
    await vi.advanceTimersByTimeAsync(10);
    session.ingest(event('t2'));
    session.stop();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getSnapshot().revision).toBe(1);
    expect(session.getSnapshot().canRetry).toBe(true);
    expect(session.getSnapshot().queued[0]?.id).toBe('t2');
    session.retry();
    await vi.advanceTimersByTimeAsync(1);
    expect(requests[1]).toEqual(requests[0]);
    expect(session.getSnapshot().lastResult?.stats.duplicates).toBe(1);
    expect(session.getSnapshot().queued).toHaveLength(1);
  });
  it('a request queued immediately after reset waits for old consumer cleanup', async () => {
    const requests: GenerationRequest[] = [];
    const transport: GenerationTransport = adaptRawFixtureTransport({
      async *generate(request) {
        requests.push(request);
        if (requests.length === 1) await new Promise(() => {});
        yield new Uint8Array();
      },
    });
    const { session } = harness({ transport });
    session.ingest(event('t1'));
    session.sendNow();
    await vi.advanceTimersByTimeAsync(1);
    session.reset({ confirmed: true });
    session.ingest(event('t2'));
    session.sendNow();
    await vi.advanceTimersByTimeAsync(5);
    expect(requests).toHaveLength(2);
    expect(session.getSnapshot().canRetry).toBe(false);
    expect(requests[1]?.sessionEpoch).toBe(1);
    expect(requests[1]?.transcript.segmentIds).toEqual(['t2']);
  });
  it('generation-only invalidation preserves unsent speech for an explicit fresh send', async () => {
    const { session, store, requests } = harness();
    session.ingest(event('t1'));
    store.cancelGeneration();
    expect(session.getSnapshot().queued[0]?.id).toBe('t1');
    expect(session.getSnapshot().generation).toBe('paused');
    session.sendNow();
    await vi.advanceTimersByTimeAsync(1);
    expect(requests[0]?.sessionEpoch).toBe(1);
    expect(requests[0]?.transcript.segmentIds).toEqual(['t1']);
  });
  it('Pause during permission request releases a later-granted microphone and does not start mock transcription', async () => {
    let grant: (stream: MediaStream) => void = () => {};
    const stop = vi.fn();
    const track = { stop, readyState: 'live' };
    const mic = new MicrophonePreviewSource({
      environment: {
        secure: true,
        supported: true,
        now: () => Date.now(),
        getUserMedia: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
        createRecorder: () => {
          throw new Error('must not record');
        },
        createObjectURL: () => '',
        revokeObjectURL() {},
      },
    });
    const { session } = harness({ microphone: mic });
    const starting = session.start('microphone');
    expect(session.getSnapshot().capture).toBe('requesting');
    session.pause();
    grant({ getTracks: () => [track] } as unknown as MediaStream);
    await starting;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().capture).toBe('paused');
    expect(session.getSnapshot().transcript).toEqual([]);
  });
  it('requires confirmed reset and ignores an old request completion after resetting', async () => {
    const transport: GenerationTransport = adaptRawFixtureTransport({
      async *generate() {
        await new Promise(() => {});
        yield new Uint8Array();
      },
    });
    const { session, store } = harness({ transport });
    session.ingest(event('t1'));
    session.sendNow();
    const epoch = store.getSessionEpoch();
    expect(session.reset({ confirmed: false })).toBe(false);
    expect(store.getSessionEpoch()).toBe(epoch);
    expect(session.reset({ confirmed: true })).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.getSnapshot()).toMatchObject({
      epoch: epoch + 1,
      generation: 'idle',
      queued: [],
      canRetry: false,
      inspector: null,
    });
    expect(store.getSnapshot().revision).toBe(0);
  });
});
