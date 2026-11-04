import { freeze } from '../stream/types';
import type { CaptureState } from './types';

export interface PreviewClip {
  id: number;
  url: string;
  durationMs: number;
  bytes: number;
  mimeType: string;
}
export interface MicrophoneSnapshot {
  state: CaptureState;
  label: 'Local recording — transcription mocked';
  message: string;
  clips: readonly PreviewClip[];
  retainedMs: number;
  bufferedBytes: number;
  droppedMs: number;
}
export interface MediaEnvironment {
  secure: boolean;
  supported: boolean;
  getUserMedia(): Promise<MediaStream>;
  createRecorder(stream: MediaStream): MediaRecorder;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  now(): number;
}
export interface MicrophoneOptions {
  environment?: MediaEnvironment;
  segmentMs?: number;
  maxDurationMs?: number;
  maxBytes?: number;
}
function browserEnvironment(): MediaEnvironment {
  return {
    secure: typeof isSecureContext !== 'undefined' && isSecureContext,
    supported:
      typeof MediaRecorder !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia,
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
    createRecorder(stream) {
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      return new MediaRecorder(stream, {
        audioBitsPerSecond: 64_000,
        ...(mimeType ? { mimeType } : {}),
      });
    },
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    now: () => performance.now(),
  };
}
/** Complete short recordings are retained, never arbitrary undecodable timeslices. No uploads/storage. */
export class MicrophonePreviewSource {
  private readonly env: MediaEnvironment;
  private readonly segmentMs: number;
  private readonly maxMs: number;
  private readonly maxBytes: number;
  private snapshot: MicrophoneSnapshot = freeze({
    state: 'idle',
    label: 'Local recording — transcription mocked',
    message: '',
    clips: [],
    retainedMs: 0,
    bufferedBytes: 0,
    droppedMs: 0,
  });
  private listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private token = 0;
  private disposed = false;
  private clipId = 0;
  private activeBytes = 0;
  private activeStart: number | null = null;
  private ended = new Map<MediaStreamTrack, () => void>();
  constructor(options: MicrophoneOptions = {}) {
    this.env = options.environment ?? browserEnvironment();
    this.segmentMs = options.segmentMs ?? 10_000;
    this.maxMs = options.maxDurationMs ?? 60_000;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    if (
      ![this.segmentMs, this.maxMs, this.maxBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
      this.maxMs > 60_000 ||
      this.segmentMs > this.maxMs
    )
      throw new Error('Invalid local preview limits');
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<MicrophoneSnapshot>) {
    if (this.disposed) return;
    this.snapshot = freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* UI observers do not own tracks. */
      }
    }
  }
  private trim(input: readonly PreviewClip[] = this.snapshot.clips) {
    const clips = [...input];
    let total = clips.reduce((n, c) => n + c.durationMs, 0);
    let bytes = clips.reduce((n, c) => n + c.bytes, 0);
    let dropped = this.snapshot.droppedMs;
    const activeMs = this.activeStart === null ? 0 : Math.max(0, this.env.now() - this.activeStart);
    while (
      clips.length &&
      (total + activeMs > this.maxMs || bytes + this.activeBytes > this.maxBytes)
    ) {
      const clip = clips.shift()!;
      this.env.revokeObjectURL(clip.url);
      total -= clip.durationMs;
      bytes -= clip.bytes;
      dropped += clip.durationMs;
    }
    this.publish({
      clips,
      retainedMs: total + Math.min(activeMs, this.maxMs),
      bufferedBytes: bytes + this.activeBytes,
      droppedMs: dropped,
      ...(dropped
        ? {
            message:
              'Older local recordings were discarded to keep the 60-second/byte preview bound.',
          }
        : {}),
    });
  }
  private release() {
    this.token++;
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.ticker = undefined;
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        /* Tracks still stop below. */
      }
    }
    for (const [track, listener] of this.ended) track.removeEventListener('ended', listener);
    this.ended.clear();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.snapshot.clips.forEach((clip) => this.env.revokeObjectURL(clip.url));
    this.activeBytes = 0;
    this.activeStart = null;
    this.publish({ clips: [], retainedMs: 0, bufferedBytes: 0 });
  }
  private fail(message: string) {
    this.release();
    this.publish({ state: 'error', message });
  }
  private segment() {
    if (!this.stream || this.snapshot.state !== 'recording' || this.recorder || this.disposed)
      return;
    const token = this.token;
    const started = this.env.now();
    let chunks: Blob[] = [];
    this.activeBytes = 0;
    this.activeStart = started;
    try {
      const recorder = this.env.createRecorder(this.stream);
      this.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (token !== this.token || this.disposed || !event.data.size) return;
        this.activeBytes += event.data.size;
        if (this.activeBytes > this.maxBytes || this.env.now() - started > this.maxMs) {
          chunks = [];
          this.fail(
            'Local preview limit reached while recording. This segment was discarded. Start again.',
          );
          return;
        }
        chunks.push(event.data);
        this.trim();
      };
      recorder.onerror = () => {
        if (token === this.token)
          this.fail('Recording failed. Check the microphone connection and Start again.');
      };
      recorder.onstop = () => {
        if (token !== this.token || this.disposed) return;
        this.recorder = null;
        const durationMs = Math.max(0, this.env.now() - started);
        this.activeBytes = 0;
        this.activeStart = null;
        if (chunks.length && durationMs <= this.maxMs) {
          const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]!.type });
          try {
            this.trim([
              ...this.snapshot.clips,
              {
                id: ++this.clipId,
                url: this.env.createObjectURL(blob),
                durationMs,
                bytes: blob.size,
                mimeType: blob.type,
              },
            ]);
          } catch {
            this.fail('Unable to create a local preview. Start again.');
            return;
          }
        }
        chunks = [];
        this.trim();
        this.segment();
      };
      recorder.start(1000);
    } catch {
      this.fail(
        'This browser cannot start an audio recorder. Try a supported browser or use Mock demo.',
      );
    }
  }
  async start(): Promise<void> {
    if (this.disposed || ['requesting', 'recording', 'paused'].includes(this.snapshot.state))
      return;
    this.release();
    this.publish({ state: 'requesting', message: '', droppedMs: 0 });
    const token = this.token;
    if (!this.env.secure) {
      this.fail('Microphone requires HTTPS or localhost. Use Mock demo without permission.');
      return;
    }
    if (!this.env.supported) {
      this.fail(
        'MediaRecorder or microphone capture is unavailable. Use a supported browser or Mock demo.',
      );
      return;
    }
    try {
      const stream = await this.env.getUserMedia();
      if (this.disposed || token !== this.token) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) {
        stream.getTracks().forEach((track) => track.stop());
        this.fail('No live microphone device. Connect a microphone and Start again.');
        return;
      }
      this.stream = stream;
      for (const track of stream.getTracks()) {
        const listener = () =>
          this.fail('Microphone disconnected. Reconnect it and Start again, or use Mock demo.');
        this.ended.set(track, listener);
        track.addEventListener('ended', listener, { once: true });
      }
      this.publish({ state: 'recording' });
      this.segment();
      if (this.snapshot.state !== 'recording') return;
      this.ticker = setInterval(() => {
        if (this.snapshot.state !== 'recording') return;
        this.trim();
        if (
          this.activeStart !== null &&
          this.env.now() - this.activeStart >= this.segmentMs &&
          this.recorder?.state === 'recording'
        ) {
          try {
            this.recorder.stop();
          } catch {
            this.fail('Unable to finalize local recording. Start again.');
          }
        }
      }, 250);
    } catch (error) {
      if (token !== this.token || this.disposed) return;
      const name = error instanceof Error ? error.name : '';
      this.fail(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone permission denied. Allow microphone access in browser settings and Start again, or use Mock demo.'
          : name === 'NotFoundError'
            ? 'No microphone found. Connect a device and Start again, or use Mock demo.'
            : 'Microphone is unavailable or busy. Check the device and Start again, or use Mock demo.',
      );
    }
  }
  pause() {
    if (this.snapshot.state === 'requesting') {
      this.stop();
      return;
    }
    if (this.snapshot.state !== 'recording') return;
    this.publish({ state: 'paused' });
    this.stream?.getTracks().forEach((track) => {
      track.enabled = false;
    });
    try {
      if (this.recorder?.state === 'recording') this.recorder.stop();
    } catch {
      this.fail('Unable to pause recording. Start again.');
    }
  }
  resume() {
    if (this.snapshot.state !== 'paused' || this.disposed) return;
    this.stream?.getTracks().forEach((track) => {
      track.enabled = true;
    });
    this.publish({ state: 'recording' });
    this.segment();
  }
  stop() {
    this.release();
    this.publish({ state: 'idle', message: 'Local recording stopped; preview audio discarded.' });
  }
  dispose() {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.listeners.clear();
  }
}
