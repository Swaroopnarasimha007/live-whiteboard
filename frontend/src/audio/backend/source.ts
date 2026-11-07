import { idSchema } from '../../contracts';
import {
  speechEventSchema,
  type CaptureState,
  type SpeechEvent,
  type SpeechSource,
} from '../types';
import { browserAudioEnvironment, type AudioEnvironment, type PcmCapture } from './browser';
import { audioServerEventSchema, type AudioSessionConfig } from './protocol';

export interface BackendSpeechOptions {
  session(): AudioSessionConfig;
  environment?: AudioEnvironment;
  frameMs?: number;
  maxBufferMs?: number;
  handshakeMs?: number;
  completionMs?: number;
  maxPendingAudioMs?: number;
  streamId?: () => string;
  onError?: (error: { code: string; message: string }) => void;
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Audio connection timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
interface Run {
  socket: WebSocket;
  controller: AbortController;
  session: AudioSessionConfig;
  id: string;
  ready: ReturnType<typeof deferred>;
  closed: ReturnType<typeof deferred>;
  acknowledged: boolean;
  terminal: boolean;
  finishing: boolean;
  capture?: PcmCapture;
  queue: ArrayBuffer[];
  bytes: number;
  sentBytes: number;
  processedBytes: number;
  credits: number;
  offset: number;
  timer?: ReturnType<typeof setInterval>;
  last?: SpeechEvent;
  remove(): void;
}

/** PCM speech source only. B3 supplies an authorized session and connects it to the existing scheduler. */
export class BackendSpeechSource implements SpeechSource {
  private readonly options: BackendSpeechOptions;
  private readonly env: AudioEnvironment;
  private readonly frameMs: number;
  private readonly maxBufferMs: number;
  private run: Run | undefined;
  private ending: Promise<void> = Promise.resolve();
  private disposed = false;
  private wantsRecording = false;
  private timelineMs = 0;
  private transcribing = false;
  private progressListeners = new Set<() => void>();
  getTranscribing = () => this.transcribing;
  subscribeProgress = (listener: () => void) => {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  };
  private progress(value: boolean) {
    this.transcribing = value;
    for (const listener of this.progressListeners) listener();
  }
  private lastState: CaptureState = 'idle';
  private pending: SpeechEvent[] = [];
  private onEvent: (event: SpeechEvent) => boolean = () => true;
  private onState: (state: CaptureState) => void = () => {};

  constructor(options: BackendSpeechOptions) {
    this.options = options;
    this.env = options.environment ?? browserAudioEnvironment();
    this.frameMs = options.frameMs ?? 100;
    this.maxBufferMs = options.maxBufferMs ?? 2000;
    if (
      !Number.isInteger(this.frameMs) ||
      this.frameMs < 1 ||
      this.frameMs > 1000 ||
      !Number.isInteger(this.maxBufferMs) ||
      this.maxBufferMs < this.frameMs ||
      this.maxBufferMs > 10000 ||
      !Number.isFinite(options.maxPendingAudioMs ?? 30000) ||
      (options.maxPendingAudioMs ?? 30000) < this.frameMs ||
      (options.maxPendingAudioMs ?? 30000) > 45000 ||
      [options.handshakeMs ?? 120000, options.completionMs ?? 120000].some(
        (v) => !Number.isFinite(v) || v <= 0,
      )
    )
      throw new Error('Invalid backend audio limits');
  }

  private state(state: CaptureState) {
    this.lastState = state;
    if (!this.disposed) {
      try {
        this.onState(state);
      } catch {
        /* Observers do not own capture. */
      }
    }
  }
  start(
    onEvent: (event: SpeechEvent) => boolean,
    onState: (state: CaptureState) => void = () => {},
  ) {
    if (this.disposed || this.wantsRecording) return;
    this.onEvent = onEvent;
    this.onState = onState;
    this.resume();
  }
  resume() {
    if (this.disposed || this.wantsRecording) return;
    while (this.pending.length) {
      if (!this.onEvent(this.pending[0]!)) {
        this.state('paused');
        return;
      }
      this.pending.shift();
    }
    this.wantsRecording = true;
    this.state('requesting');
    void this.begin();
  }

  private async begin() {
    await this.ending;
    if (this.disposed || !this.wantsRecording || this.run) return;
    if (!this.env.secure || !this.env.supported) {
      this.fail(
        'unsupported_capture',
        'Microphone capture needs HTTPS/localhost and AudioWorklet support.',
      );
      return;
    }
    let run: Run | undefined;
    try {
      const session = { ...this.options.session() };
      idSchema.parse(session.profile);
      if (!Number.isSafeInteger(session.sessionEpoch) || session.sessionEpoch < 0)
        throw new Error('Invalid epoch');
      const url = new URL(session.url);
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Invalid socket URL');
      const id = idSchema.parse(this.options.streamId?.() ?? `a_${crypto.randomUUID()}`);
      if (id.length > 48) throw new Error('Invalid stream ID');
      const socket = this.env.connect(session.url);
      run = {
        socket,
        session,
        id,
        controller: new AbortController(),
        ready: deferred(),
        closed: deferred(),
        acknowledged: false,
        terminal: false,
        finishing: false,
        queue: [],
        bytes: 0,
        sentBytes: 0,
        processedBytes: 0,
        credits: 0,
        offset: this.timelineMs,
        remove() {},
      };
      this.run = run;
      const active = run;
      const open = () => {
        if (this.run !== active) return;
        socket.send(
          JSON.stringify({
            type: 'start',
            audioProtocolVersion: 1,
            streamId: id,
            sessionEpoch: session.sessionEpoch,
            profile: session.profile,
            format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 },
          }),
        );
      };
      const message = (event: MessageEvent) => {
        if (this.run !== active) return;
        try {
          if (
            typeof event.data !== 'string' ||
            new TextEncoder().encode(event.data).byteLength > 65536
          )
            throw new Error('Unexpected audio event');
          const data = audioServerEventSchema.parse(JSON.parse(event.data));
          if (data.streamId !== id || data.sessionEpoch !== session.sessionEpoch) return; // late stream/epoch
          if (active.terminal) throw new Error('Audio event after close');
          if (data.type === 'ready') {
            if (active.acknowledged || data.profile !== session.profile)
              throw new Error('Invalid audio ready');
            active.acknowledged = true;
            active.ready.resolve();
          } else if (data.type === 'processed') {
            if (data.samples * 2 < active.processedBytes || data.samples * 2 > active.sentBytes)
              throw new Error('Invalid audio acknowledgement');
            active.processedBytes = data.samples * 2;
          } else if (data.type === 'progress') {
            this.progress(data.stage === 'transcribing');
          } else if (data.type === 'transcript') {
            if (!active.acknowledged) throw new Error('Transcript before ready');
            const { id: segmentId, text, startMs, endMs, isFinal } = data;
            const last = active.last;
            if (
              last &&
              (segmentId === last.id
                ? last.isFinal || startMs !== last.startMs || endMs < last.endMs
                : startMs < last.endMs)
            )
              throw new Error('Invalid transcript revision/order');
            active.last = { id: segmentId, text, startMs, endMs, isFinal };
            if (text.trim())
              this.deliver(
                speechEventSchema.parse({
                  id: segmentId,
                  text,
                  startMs: startMs + active.offset,
                  endMs: endMs + active.offset,
                  isFinal,
                }),
              );
          } else if (data.type === 'error') this.fail(data.code, data.message, active);
          else {
            active.terminal = true;
            if (data.reason !== 'finished') {
              this.fail(
                'capture_interrupted',
                'The backend did not finish flushing capture. Restart to continue.',
                active,
              );
              return;
            }
            active.closed.resolve();
            if (this.wantsRecording && !active.finishing)
              this.fail(
                'capture_closed',
                'The backend ended capture. Start a new stream to continue.',
                active,
              );
          }
        } catch {
          this.fail('invalid_audio_protocol', 'The backend sent an invalid audio event.', active);
        }
      };
      const close = () => {
        if (this.run !== active) return;
        active.ready.reject(new Error('Audio disconnected'));
        active.closed.reject(new Error('Audio disconnected'));
        if (!active.terminal)
          this.fail(
            'disconnected',
            'Audio connection was interrupted. Start a new capture; audio is not replayed.',
            active,
          );
      };
      socket.addEventListener('open', open);
      socket.addEventListener('message', message);
      socket.addEventListener('close', close);
      socket.addEventListener('error', close);
      active.remove = () => {
        socket.removeEventListener('open', open);
        socket.removeEventListener('message', message);
        socket.removeEventListener('close', close);
        socket.removeEventListener('error', close);
      };
      if (socket.readyState === 1) open();
      await deadline(active.ready.promise, this.options.handshakeMs ?? 120000);
      if (this.run !== active || !this.wantsRecording) return;
      active.timer = setInterval(() => this.pump(active), 20);
      active.capture = await this.env.capture(
        (frame) => {
          if (this.run !== active) return;
          if (!frame.byteLength || frame.byteLength % 2 || frame.byteLength > 32000) {
            this.fail('invalid_audio', 'Capture produced an invalid PCM frame.', active);
            return;
          }
          if (
            active.bytes + active.socket.bufferedAmount + frame.byteLength >
            this.maxBufferMs * 32
          ) {
            this.fail(
              'overloaded',
              'Audio buffer exceeded its limit. Capture was interrupted; restart to continue.',
              active,
            );
            return;
          }
          active.queue.push(frame);
          active.bytes += frame.byteLength;
          this.pump(active);
          if (
            !active.finishing &&
            active.sentBytes - active.processedBytes >=
              (this.options.maxPendingAudioMs ?? 30000) * 32
          ) {
            // Finish captured audio before the bounded server queue fills.
            void this.finish();
            this.options.onError?.({
              code: 'audio_backlog',
              message:
                'Recording ended because transcription is catching up. Captured audio is being finalized.',
            });
          }
        },
        (code) =>
          this.fail(
            code,
            'Microphone capture was interrupted. Check the device and restart capture.',
            active,
          ),
        this.frameMs,
        this.maxBufferMs,
        active.controller.signal,
      );
      if (this.run !== active || !this.wantsRecording) {
        await active.capture.abort();
        return;
      }
      this.state('recording');
    } catch (error) {
      if (run && this.run !== run) return;
      const name = error instanceof Error ? error.name : '';
      this.fail(
        name === 'NotAllowedError'
          ? 'permission_denied'
          : name === 'NotFoundError'
            ? 'device_not_found'
            : 'capture_failed',
        name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow access and retry.'
          : name === 'NotFoundError'
            ? 'No microphone is available.'
            : 'Audio capture could not start. Check the backend and microphone.',
        run,
      );
    }
  }

  private pump(run: Run) {
    if (this.run !== run || !run.acknowledged || run.socket.readyState !== 1) return;
    try {
      const limit = this.maxBufferMs * 32;
      while (run.queue.length && run.socket.bufferedAmount + run.queue[0]!.byteLength <= limit) {
        const frame = run.queue.shift()!;
        run.socket.send(frame);
        run.sentBytes += frame.byteLength;
        run.bytes -= frame.byteLength;
        run.credits += frame.byteLength;
      }
      if (!run.socket.bufferedAmount && run.capture && run.credits) {
        run.capture.credit(run.credits);
        run.credits = 0;
      }
    } catch {
      this.fail('disconnected', 'Audio send failed. Restart capture to continue.', run);
    }
  }

  private deliver(event: SpeechEvent) {
    if (!this.pending.length && this.onEvent(event)) return;
    const index = this.pending.findIndex((e) => e.id === event.id);
    if (index >= 0) this.pending[index] = event;
    else this.pending.push(event);
    const chars = this.pending.reduce((n, e) => n + e.text.length, 0);
    const duration = this.pending.reduce((n, e) => n + (e.isFinal ? e.endMs - e.startMs : 0), 0);
    if (chars > 10000 || duration > 30000 || this.pending.length > 256) {
      this.fail(
        'transcript_overloaded',
        'Unsent transcript exceeded its limit. Send or reset it before recording more.',
      );
      return;
    }
    this.pause();
  }

  async finish() {
    this.wantsRecording = false;
    this.state('finishing');
    this.end(true);
    await this.ending;
    if (!this.run && this.lastState !== 'error') this.state('idle');
  }

  pause() {
    if (this.disposed) return;
    this.wantsRecording = false;
    this.state('paused');
    this.end(true);
  }
  stop() {
    this.wantsRecording = false;
    this.end(false);
    this.state('idle');
  }
  reset() {
    this.stop();
    this.timelineMs = 0;
    this.pending = [];
  }
  dispose() {
    this.stop();
    this.disposed = true;
  }

  private end(flush: boolean) {
    const run = this.run;
    if (!run) return;
    if (flush && run.capture) {
      if (run.finishing) return;
      run.finishing = true;
      // Detach only after final transcript delivery. Resume waits for this promise.
      this.ending = (async () => {
        try {
          await run.capture!.finish();
          const until = Date.now() + (this.options.completionMs ?? 120000);
          while (this.run === run && (run.bytes || run.socket.bufferedAmount)) {
            this.pump(run);
            if (Date.now() >= until) throw new Error('Audio flush timed out');
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          if (this.run !== run) return;
          run.socket.send(JSON.stringify({ type: 'finish' }));
          await deadline(run.closed.promise, this.options.completionMs ?? 120000);
        } catch {
          if (this.run === run)
            this.fail(
              'flush_interrupted',
              'Final audio could not be flushed. Capture was interrupted.',
              run,
            );
        } finally {
          if (this.run === run) this.detach(run);
        }
      })();
    } else {
      if (run.socket.readyState === 1) {
        try {
          run.socket.send(JSON.stringify({ type: 'abort' }));
        } catch {
          /* cleanup continues */
        }
      }
      this.detach(run);
    }
  }

  private detach(run: Run) {
    if (this.run !== run) return;
    this.run = undefined;
    this.progress(false);
    this.timelineMs = Math.max(this.timelineMs, run.offset + run.sentBytes / 32);
    run.ready.reject(new Error('Capture closed'));
    run.closed.reject(new Error('Capture closed'));
    clearInterval(run.timer);
    run.remove();
    run.controller.abort();
    void run.capture?.abort().catch(() => {});
    run.queue = [];
    run.socket.close();
  }

  private fail(code: string, message: string, run = this.run) {
    if (run && this.run !== run) return;
    this.wantsRecording = false;
    if (run) this.detach(run);
    this.state('error');
    try {
      this.options.onError?.({ code, message });
    } catch {
      /* Cleanup already completed. */
    }
  }
}
