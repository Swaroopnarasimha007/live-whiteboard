import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MicrophonePreviewSource, type MediaEnvironment } from './microphone';
import { MockSpeechSource } from './mock';
import type { SpeechEvent } from './types';

class Track extends EventTarget {
  enabled = true;
  readyState = 'live';
  stops = 0;
  stop() {
    this.stops++;
    this.readyState = 'ended';
  }
}
class Recorder {
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  chunk(bytes = 10) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) });
  }
  stop() {
    this.state = 'inactive';
    this.chunk();
    this.onstop?.();
  }
}
let cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  vi.useRealTimers();
});
function media(
  extra: Partial<MediaEnvironment> = {},
  options: Partial<ConstructorParameters<typeof MicrophonePreviewSource>[0]> = {},
) {
  const track = new Track();
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const recorders: Recorder[] = [];
  const revoked: string[] = [];
  let urls = 0;
  const env: MediaEnvironment = {
    secure: true,
    supported: true,
    getUserMedia: vi.fn(async () => stream),
    createRecorder: () => {
      const r = new Recorder();
      recorders.push(r);
      return r as unknown as MediaRecorder;
    },
    now: () => Date.now(),
    createObjectURL: () => `blob:local-${++urls}`,
    revokeObjectURL: (url) => revoked.push(url),
    ...extra,
  };
  const mic = new MicrophonePreviewSource({ environment: env, ...options });
  cleanups.push(() => mic.dispose());
  return { mic, env, stream, track, recorders, revoked };
}
describe('local microphone preview', () => {
  it('does not request permission until Start; rotates complete recordings and pauses local capture', async () => {
    const { mic, env, recorders, track } = media({}, { segmentMs: 1000 });
    expect(env.getUserMedia).not.toHaveBeenCalled();
    await mic.start();
    expect(mic.getSnapshot()).toMatchObject({
      state: 'recording',
      label: 'Local recording — transcription mocked',
    });
    recorders[0]!.chunk();
    expect(mic.getSnapshot().clips).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mic.getSnapshot().clips).toHaveLength(1);
    expect(recorders).toHaveLength(2);
    mic.pause();
    expect(track.enabled).toBe(false);
    expect(mic.getSnapshot().state).toBe('paused');
    mic.resume();
    expect(track.enabled).toBe(true);
    expect(mic.getSnapshot().state).toBe('recording');
  });
  it('discards oldest complete clips visibly at the duration cap and revokes every URL on Stop', async () => {
    const { mic, track, revoked } = media({}, { segmentMs: 1000, maxDurationMs: 3000 });
    await mic.start();
    await vi.advanceTimersByTimeAsync(5500);
    expect(mic.getSnapshot().retainedMs).toBeLessThanOrEqual(3000);
    expect(mic.getSnapshot().droppedMs).toBeGreaterThan(0);
    expect(revoked.length).toBeGreaterThan(0);
    const retained = mic.getSnapshot().clips.map((c) => c.url);
    mic.stop();
    expect(track.stops).toBe(1);
    expect(mic.getSnapshot().clips).toEqual([]);
    expect(revoked).toEqual(expect.arrayContaining(retained));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds bytes and terminates oversized active recording with an actionable error', async () => {
    const { mic, recorders, track } = media({}, { maxBytes: 20 });
    await mic.start();
    recorders[0]!.chunk(21);
    expect(mic.getSnapshot()).toMatchObject({ state: 'error', bufferedBytes: 0, clips: [] });
    expect(track.stops).toBe(1);
    expect(mic.getSnapshot().message).toContain('discarded');
  });
  it.each(['NotAllowedError', 'NotFoundError', 'NotReadableError'])(
    'reports %s with recovery guidance',
    async (name) => {
      const { mic } = media({
        getUserMedia: async () => {
          throw new DOMException('failure', name);
        },
      });
      await mic.start();
      expect(mic.getSnapshot().state).toBe('error');
      expect(mic.getSnapshot().message).toMatch(/Start again|Mock demo/);
    },
  );
  it.each([{ secure: false }, { supported: false }])(
    'detects unavailable capture before asking permission: %j',
    async (capabilities) => {
      const { mic, env } = media(capabilities);
      await mic.start();
      expect(env.getUserMedia).not.toHaveBeenCalled();
      expect(mic.getSnapshot().state).toBe('error');
    },
  );
  it('releases tracks granted after Stop while permission was pending', async () => {
    let grant: (stream: MediaStream) => void = () => {};
    const { mic, stream, track } = media({
      getUserMedia: () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    });
    const starting = mic.start();
    expect(mic.getSnapshot().state).toBe('requesting');
    mic.stop();
    grant(stream);
    await starting;
    expect(track.stops).toBe(1);
    expect(mic.getSnapshot().state).toBe('idle');
  });
  it('device removal and recorder errors stop all tracks and discard URLs', async () => {
    const one = media();
    await one.mic.start();
    one.track.dispatchEvent(new Event('ended'));
    expect(one.mic.getSnapshot().state).toBe('error');
    expect(one.mic.getSnapshot().message).toContain('disconnected');
    expect(one.track.stops).toBe(1);
    const two = media();
    await two.mic.start();
    two.recorders[0]!.onerror?.();
    expect(two.mic.getSnapshot().state).toBe('error');
    expect(two.track.stops).toBe(1);
  });
  it('disposal releases active resources and prevents restart', async () => {
    const { mic, track, env } = media();
    await mic.start();
    mic.dispose();
    await mic.start();
    expect(track.stops).toBe(1);
    expect(env.getUserMedia).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('mock speech events', () => {
  it('emits the default finalized tour fixtures without microphone permission', async () => {
    const source = new MockSpeechSource();
    cleanups.push(() => source.dispose());
    const events: SpeechEvent[] = [];
    source.start((event) => {
      events.push(event);
      return true;
    });
    await vi.advanceTimersByTimeAsync(15000);
    expect(events.every((e) => e.isFinal)).toBe(true);
    expect(events).toHaveLength(7);
    expect(events.some((e) => e.id.startsWith('tour-edit-1'))).toBe(true);
    expect(events.some((e) => e.id.startsWith('tour-4'))).toBe(true);
    expect(new Set(events.filter((e) => e.isFinal).map((e) => e.id)).size).toBe(
      events.filter((e) => e.isFinal).length,
    );
  });
  it('retains rejected events under backpressure and preserves remaining time on pause', async () => {
    const source = new MockSpeechSource([
      { atMs: 1000, event: { id: 't1', text: 'One', startMs: 0, endMs: 100, isFinal: true } },
    ]);
    cleanups.push(() => source.dispose());
    let accepted = false;
    const received: SpeechEvent[] = [];
    source.start((event) => {
      if (accepted) received.push(event);
      return accepted;
    });
    await vi.advanceTimersByTimeAsync(400);
    source.pause();
    await vi.advanceTimersByTimeAsync(2000);
    source.resume();
    await vi.advanceTimersByTimeAsync(599);
    expect(received).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    accepted = true;
    source.resume();
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toHaveLength(1);
  });
  it('stops timers and assigns unique finalized IDs on another default run', async () => {
    const source = new MockSpeechSource();
    cleanups.push(() => source.dispose());
    const ids: string[] = [];
    source.start((event) => {
      if (event.isFinal) ids.push(event.id);
      return true;
    });
    await vi.advanceTimersByTimeAsync(6000);
    const first = [...ids];
    source.start((event) => {
      if (event.isFinal) ids.push(event.id);
      return true;
    });
    await vi.advanceTimersByTimeAsync(6000);
    expect(ids.length).toBe(first.length * 2);
    expect(new Set(ids).size).toBe(ids.length);
    source.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
