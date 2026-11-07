import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpeechEvent } from '../types';
import type { AudioEnvironment } from './browser';
import { BackendSpeechSource } from './source';

const ticks = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
class Socket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  sent: (string | ArrayBuffer)[] = [];
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  send(data: string | ArrayBuffer) {
    if (this.readyState !== 1) throw new Error('closed');
    this.sent.push(data);
    if (typeof data === 'string' && JSON.parse(data).type === 'finish')
      queueMicrotask(() => this.event({ type: 'closed', reason: 'finished' }));
  }
  start() {
    return JSON.parse(this.sent.find((data) => typeof data === 'string') as string) as {
      streamId: string;
      sessionEpoch: number;
      profile: string;
    };
  }
  event(data: object) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          streamId: this.start().streamId,
          sessionEpoch: this.start().sessionEpoch,
          ...data,
        }),
      }),
    );
  }
  ready() {
    this.event({
      type: 'ready',
      profile: this.start().profile,
      format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 },
    });
  }
  close() {
    this.readyState = 3;
  }
  disconnect() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
});
function harness(extra: Partial<ConstructorParameters<typeof BackendSpeechSource>[0]> = {}) {
  const sockets: Socket[] = [];
  let emit: (buffer: ArrayBuffer) => void = () => {};
  const events: SpeechEvent[] = [];
  const errors: string[] = [];
  const states: string[] = [];
  let stops = 0;
  let captures = 0;
  let next = 0;
  const environment: AudioEnvironment = {
    secure: true,
    supported: true,
    connect() {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    async capture(onFrame) {
      captures++;
      emit = onFrame;
      return {
        async finish() {},
        async abort() {
          stops++;
        },
        credit() {},
      };
    },
  };
  const source = new BackendSpeechSource({
    environment,
    session: () => ({ url: 'ws://localhost:8000/audio', sessionEpoch: 1, profile: 'mock' }),
    streamId: () => `a${++next}`,
    onError: (e) => errors.push(e.code),
    ...extra,
  });
  cleanups.push(() => source.dispose());
  const start = async (
    callback: (event: SpeechEvent) => boolean = (event) => {
      events.push(event);
      return true;
    },
  ) => {
    source.start(callback, (state) => states.push(state));
    await ticks();
    const socket = sockets.at(-1)!;
    socket.open();
    return socket;
  };
  const ready = async (socket: Socket) => {
    socket.ready();
    await ticks();
  };
  return {
    source,
    sockets,
    events,
    errors,
    states,
    start,
    ready,
    emit: (bytes = 3200) => emit(new ArrayBuffer(bytes)),
    stats: () => ({ stops, captures }),
    environment,
  };
}

describe('backend PCM speech source', () => {
  it('waits for ready before capture and adapts ordered transcript revisions', async () => {
    const h = harness();
    const socket = await h.start();
    expect(h.stats().captures).toBe(0);
    expect(socket.start()).toMatchObject({ streamId: 'a1', profile: 'mock', sessionEpoch: 1 });
    await h.ready(socket);
    expect(h.stats().captures).toBe(1);
    h.emit();
    socket.event({
      type: 'transcript',
      id: 'a1_1',
      text: 'hello',
      startMs: 0,
      endMs: 50,
      isFinal: false,
    });
    socket.event({
      type: 'transcript',
      id: 'a1_1',
      text: 'hello world',
      startMs: 0,
      endMs: 100,
      isFinal: true,
    });
    expect(h.events.map((e) => e.isFinal)).toEqual([false, true]);
    expect(socket.sent.filter((data) => data instanceof ArrayBuffer)).toHaveLength(1);
    h.source.stop();
    await ticks();
    expect(h.stats().stops).toBe(1);
    socket.event({
      type: 'transcript',
      id: 'late',
      text: 'late',
      startMs: 0,
      endMs: 200,
      isFinal: true,
    });
    expect(h.events).toHaveLength(2);
  });

  it('flushes pause, resumes with a fresh stream and sample-based session offsets', async () => {
    const h = harness();
    const first = await h.start();
    await h.ready(first);
    h.emit();
    first.event({
      type: 'transcript',
      id: 'a1_1',
      text: 'first',
      startMs: 0,
      endMs: 100,
      isFinal: true,
    });
    h.source.pause();
    h.source.pause();
    h.source.resume();
    await ticks();
    expect(h.errors).toEqual([]);
    const second = h.sockets[1]!;
    second.open();
    await h.ready(second);
    h.emit();
    second.event({
      type: 'transcript',
      id: 'a2_1',
      text: 'second',
      startMs: 0,
      endMs: 100,
      isFinal: true,
    });
    expect(h.events.map((e) => [e.startMs, e.endMs])).toEqual([
      [0, 100],
      [100, 200],
    ]);
    expect(
      first.sent.filter((data) => typeof data === 'string' && JSON.parse(data).type === 'finish'),
    ).toHaveLength(1);
    expect(first.start().streamId).not.toBe(second.start().streamId);
  });

  it('retains refused final text under backpressure and drains it before resuming', async () => {
    const h = harness();
    let accepting = false;
    const socket = await h.start((event) => {
      if (!accepting) return false;
      h.events.push(event);
      return true;
    });
    await h.ready(socket);
    socket.event({
      type: 'transcript',
      id: 'a1_1',
      text: 'retained',
      startMs: 0,
      endMs: 100,
      isFinal: true,
    });
    await ticks();
    expect(h.states.at(-1)).toBe('paused');
    h.source.resume();
    await ticks();
    expect(h.sockets).toHaveLength(1);
    accepting = true;
    h.source.resume();
    await ticks();
    expect(h.events[0]?.text).toBe('retained');
    expect(h.sockets).toHaveLength(2);
  });

  it('reports bounded-buffer overload and stops capture without replaying samples', async () => {
    const h = harness({ maxBufferMs: 100 });
    const socket = await h.start();
    await h.ready(socket);
    socket.bufferedAmount = 3200;
    h.emit();
    await ticks();
    expect(h.errors).toEqual(['overloaded']);
    expect(h.stats().stops).toBe(1);
    expect(socket.sent.filter((data) => data instanceof ArrayBuffer)).toEqual([]);
    h.source.resume();
    await ticks();
    expect(h.sockets[1]!.sent).toEqual([]);
  });

  it('rejects duplicate final revisions and ignores events from old stream IDs', async () => {
    const h = harness();
    const socket = await h.start();
    await h.ready(socket);
    const event = {
      type: 'transcript',
      id: 'a1_1',
      text: 'done',
      startMs: 0,
      endMs: 100,
      isFinal: true,
    };
    socket.event({ ...event, streamId: 'obsolete' });
    expect(h.events).toEqual([]);
    socket.event(event);
    socket.event(event);
    expect(h.errors).toEqual(['invalid_audio_protocol']);
    expect(h.events).toHaveLength(1);
  });

  it('reports an unsuccessful backend close while pause is flushing', async () => {
    const h = harness();
    const socket = await h.start();
    await h.ready(socket);
    h.source.pause();
    socket.event({ type: 'closed', reason: 'error' });
    await ticks();
    expect(h.errors).toEqual(['capture_interrupted']);
    expect(h.states.at(-1)).toBe('error');
  });

  it('cleans up on disconnect and exposes backend and permission failures', async () => {
    const h = harness();
    const socket = await h.start();
    await h.ready(socket);
    socket.disconnect();
    await ticks();
    expect(h.errors).toEqual(['disconnected']);
    expect(h.stats().stops).toBe(1);
    const missing = harness();
    const other = await missing.start();
    other.event({ type: 'error', code: 'model_not_installed', message: 'Install the model' });
    await ticks();
    expect(missing.errors).toEqual(['model_not_installed']);
    const denied = harness();
    denied.environment.capture = async () => {
      throw new DOMException('denied', 'NotAllowedError');
    };
    const deniedSocket = await denied.start();
    await denied.ready(deniedSocket);
    expect(denied.errors).toEqual(['permission_denied']);
  });

  it('times out missing ready, handles absent device and unsupported capture', async () => {
    vi.useFakeTimers();
    const h = harness({ handshakeMs: 100 });
    await h.start();
    await vi.advanceTimersByTimeAsync(101);
    expect(h.errors).toEqual(['capture_failed']);
    expect(h.stats().captures).toBe(0);
    const missing = harness();
    missing.environment.capture = async () => {
      throw new DOMException('missing', 'NotFoundError');
    };
    const socket = await missing.start();
    await missing.ready(socket);
    expect(missing.errors).toEqual(['device_not_found']);
    const unsupported = harness();
    unsupported.environment.supported = false;
    unsupported.source.start(() => true);
    await ticks();
    expect(unsupported.errors).toEqual(['unsupported_capture']);
  });
  it('release waits for server close and stops capture through graceful finish', async () => {
    const h = harness();
    const socket = await h.start();
    await h.ready(socket);
    h.emit();
    await h.source.finish();
    expect(
      socket.sent
        .filter((data) => typeof data === 'string')
        .map((data) => JSON.parse(data as string).type),
    ).toEqual(['start', 'finish']);
    expect(h.states).toContain('finishing');
    expect(h.states.at(-1)).toBe('idle');
    expect(h.stats().stops).toBeGreaterThan(0);
    expect(h.errors).toEqual([]);
  });

  it('backlog limit flushes accepted audio instead of aborting it', async () => {
    const h = harness({ maxPendingAudioMs: 100 });
    const socket = await h.start();
    await h.ready(socket);
    h.emit();
    await ticks();
    expect(
      socket.sent
        .filter((data) => typeof data === 'string')
        .map((data) => JSON.parse(data as string).type),
    ).toContain('finish');
    expect(h.errors).toContain('audio_backlog');
    expect(h.states).toContain('finishing');
  });
});
