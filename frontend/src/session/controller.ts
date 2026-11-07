import type { BackendSessionBridge } from './backend/bridge';
import type { GenerationRequest, GenerationTransport } from '../contracts';
import type { SceneStore } from '../scene';
import {
  buildGenerationRequest,
  ContextError,
  inspectGenerationRequest,
  type ContextView,
} from '../context';
import {
  MockSpeechSource,
  MicrophonePreviewSource,
  speechEventSchema,
  type CaptureState,
  type SpeechEvent,
  type SpeechSource,
} from '../audio';
import type { StreamConsumer, StreamResult } from '../stream';
import { freeze } from '../stream/types';
import { diagnostic } from '../diagnostics';

export type GenerationState = 'idle' | 'queued' | 'streaming' | 'paused' | 'error';
export type SessionMode = 'mock' | 'microphone' | 'backend';
export interface TranscriptEntry extends SpeechEvent {
  status: 'queued' | 'sent' | 'completed' | 'failed';
}
export interface RequestInspector {
  request: GenerationRequest;
  json: string;
  bytes: number;
  sentAt: number;
}
export interface SessionSnapshot {
  transcribingAudio: boolean;
  holdActive: boolean;
  holdElapsedMs: number;
  sessionId: string;
  epoch: number;
  mode: SessionMode;
  capture: CaptureState;
  generation: GenerationState;
  interim: SpeechEvent | null;
  transcript: readonly TranscriptEntry[];
  hiddenTranscriptCount: number;
  queued: readonly SpeechEvent[];
  queuedCharacters: number;
  queuedDurationMs: number;
  queueAgeMs: number;
  modelLatencyMs: number | null;
  inFlight: boolean;
  canRetry: boolean;
  message: string;
  inspector: RequestInspector | null;
  lastResult: StreamResult | null;
}
export interface SessionOptions {
  store: SceneStore;
  consumer: StreamConsumer;
  transport: GenerationTransport;
  getContext(): ContextView;
  subscribeInteraction?: (listener: () => void) => () => void;
  speech?: SpeechSource;
  backend?: BackendSessionBridge;
  microphone?: MicrophonePreviewSource;
  sessionId?: string;
  groupDelayMs?: number;
  maxQueuedCharacters?: number;
  maxQueuedDurationMs?: number;
  contextBudgetBytes?: number;
  deferredMaxAttempts?: number;
  deferredMaxAgeMs?: number;
  deferredMaxSegments?: number;
  now?: () => number;
}
interface Batch {
  request: GenerationRequest;
  events: SpeechEvent[];
  started: number;
  version: number;
}
export function createSessionController(options: SessionOptions) {
  const now = options.now ?? (() => performance.now());
  const speech = options.speech ?? new MockSpeechSource();
  const backendSpeech = options.backend?.source;
  const currentSpeech = () => (state.mode === 'backend' ? backendSpeech! : speech);
  const microphone = options.microphone ?? new MicrophonePreviewSource();
  const groupMs = options.groupDelayMs ?? 400;
  const deferredAttempts = options.deferredMaxAttempts ?? 2;
  const deferredAge = options.deferredMaxAgeMs ?? 30000;
  const deferredLimit = options.deferredMaxSegments ?? 32;
  if (
    ![deferredAttempts, deferredAge, deferredLimit].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error('Invalid deferred transcript limits');
  const maxChars = options.maxQueuedCharacters ?? 10000;
  const maxDuration = options.maxQueuedDurationMs ?? 30000;
  if (
    !Number.isFinite(groupMs) ||
    groupMs < 0 ||
    !Number.isSafeInteger(maxChars) ||
    maxChars < 1 ||
    maxChars > 10000 ||
    !Number.isFinite(maxDuration) ||
    maxDuration <= 0 ||
    maxDuration > 30000
  )
    throw new Error('Invalid transcript scheduling limits');
  const newId = () => `s_${crypto.randomUUID()}`;
  let state: SessionSnapshot = freeze({
    transcribingAudio: false,
    holdActive: false,
    holdElapsedMs: 0,
    sessionId: options.sessionId ?? newId(),
    epoch: options.store.getSessionEpoch(),
    mode: 'mock',
    capture: 'idle',
    generation: 'idle',
    interim: null,
    transcript: [],
    hiddenTranscriptCount: 0,
    queued: [],
    queuedCharacters: 0,
    queuedDurationMs: 0,
    queueAgeMs: 0,
    modelLatencyMs: null,
    inFlight: false,
    canRetry: false,
    message: '',
    inspector: null,
    lastResult: null,
  });
  const listeners = new Set<() => void>();
  const finalized = new Map<string, SpeechEvent>();
  let queue: { event: SpeechEvent; enqueuedAt: number }[] = [];
  let active: Batch | null = null;
  let failed: Batch | null = null;
  const deferred = new Map<string, { event: SpeechEvent; attempts: number; since: number }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  let paused = false;
  let stopped = false;
  let limited = false;
  let blocked = false;
  let disposed = false;
  let version = 0;
  let replacementVersion = options.store.getReplacementVersion();
  let captureToken = 0;
  let followup = false;
  let holdStarted = 0;
  let holdVersion = 0;
  const publish = (patch: Partial<SessionSnapshot> = {}) => {
    if (disposed) return;
    const events = queue.map((item) => item.event);
    const chars = events.map((e) => e.text).join(' ').length;
    const duration = events.length
      ? Math.max(...events.map((e) => e.endMs)) - Math.min(...events.map((e) => e.startMs))
      : 0;
    if (patch.generation && patch.generation !== state.generation) {
      diagnostic('session.generation_state', {
        previous: state.generation,
        next: patch.generation,
        queuedCharacters: chars,
        queuedSegments: events.length,
        paused,
        stopped,
        blocked,
        limited,
        hasFailedRequest: !!failed,
      });
    }
    state = freeze({
      ...state,
      ...patch,
      ...(state.holdActive && patch.holdActive !== false
        ? { holdElapsedMs: Math.max(0, now() - holdStarted) }
        : {}),
      queued: events,
      queuedCharacters: chars,
      queuedDurationMs: duration,
      queueAgeMs: queue.length ? Math.max(0, now() - queue[0]!.enqueuedAt) : 0,
      inFlight: !!active,
      canRetry: !!failed && failed.request.sessionEpoch === options.store.getSessionEpoch(),
      ...(active ? { modelLatencyMs: Math.max(0, now() - active.started) } : {}),
    });
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* UI is outside session lifecycle. */
      }
    }
  };
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const mark = (events: readonly SpeechEvent[], status: TranscriptEntry['status']) => {
    const ids = new Set(events.map((e) => e.id));
    return state.transcript.map((e) => (ids.has(e.id) ? { ...e, status } : e));
  };
  const run = (batch: Batch, retry: boolean) => {
    active = batch;
    failed = null;
    batch.started = now();
    publish({
      generation: 'streaming',
      message: '',
      inspector: {
        request: batch.request,
        ...inspectGenerationRequest(batch.request),
        sentAt: batch.started,
      },
      transcript: mark(batch.events, 'sent'),
    });
    void options.consumer
      .consume(batch.request, options.transport, { retry })
      .then((result) => {
        if (disposed || batch.version !== version || active !== batch) return;
        active = null;
        const incomplete = result.phase !== 'completed';
        const nonblocking = state.mode === 'backend' && result.phase !== 'cancelled';
        if (incomplete && !nonblocking) failed = batch;
        if (nonblocking) {
          for (const event of batch.events) {
            const previous = deferred.get(event.id);
            if (!incomplete) deferred.delete(event.id);
            else
              deferred.set(event.id, {
                event,
                attempts: (previous?.attempts ?? 0) + 1,
                since: previous?.since ?? now(),
              });
          }
        }
        while (deferred.size > deferredLimit) deferred.delete(deferred.keys().next().value!);
        publish({
          lastResult: result,
          modelLatencyMs: Math.max(0, now() - batch.started),
          transcript: mark(batch.events, incomplete ? 'failed' : 'completed'),
          generation: failed
            ? 'error'
            : paused || stopped
              ? 'paused'
              : queue.length
                ? 'queued'
                : 'idle',
          message: failed
            ? state.mode === 'backend'
              ? 'Partial drawing retained. Replay uses the original events. Continue with fresh context creates a new request; queued speech waits.'
              : 'Partial request retained. Retry uses the original request and operation IDs; queued speech is waiting.'
            : incomplete
              ? 'Some content was not drawn. New speech will continue; eligible text will be reconsidered with the next batch.'
              : '',
        });
        if (!failed && !paused && !stopped && queue.length) {
          ready = true;
          pump();
        }
      })
      .catch((error: unknown) => {
        if (disposed || batch.version !== version || active !== batch) return;
        active = null;
        failed = batch;
        publish({
          generation: 'error',
          message: error instanceof Error ? error.message : String(error),
          transcript: mark(batch.events, 'failed'),
        });
      });
  };
  const pump = (force = false, continuation?: Batch) => {
    if (
      disposed ||
      active ||
      (failed && !continuation) ||
      blocked ||
      (!queue.length && !continuation) ||
      (!force && (paused || stopped || !ready))
    )
      return;
    if (options.consumer.isActive()) return;
    if (state.mode === 'backend') {
      const backend = options.backend?.getSnapshot();
      if (
        backend?.status !== 'ready' ||
        backend.identity?.sessionId !== state.sessionId ||
        backend.identity.sessionEpoch !== options.store.getSessionEpoch()
      ) {
        publish({
          generation: 'paused',
          message: 'Reconnect with Start before sending queued speech.',
        });
        return;
      }
    }
    const view = options.getContext();
    if (view.interactionInProgress) {
      publish({
        generation: 'queued',
        message: 'Waiting for the active edit to finish before taking a fresh snapshot.',
      });
      return;
    }
    let request: GenerationRequest;
    try {
      const events = continuation?.events ?? queue.map((item) => item.event);
      if (!continuation && state.mode === 'backend') {
        for (const [id, item] of deferred) {
          if (item.attempts >= deferredAttempts || now() - item.since > deferredAge) {
            deferred.delete(id);
            continue;
          }
          if (
            !events.some((event) => event.id === id) &&
            events.map((event) => event.text).join(' ').length + item.event.text.length + 1 <=
              maxChars
          )
            events.unshift(item.event);
        }
      }
      const requestId = `r_${crypto.randomUUID()}`;
      request = buildGenerationRequest({
        ...view,
        scene: options.store.getSnapshot(),
        sessionEpoch: options.store.getSessionEpoch(),
        sessionId: state.sessionId,
        requestId,
        transcript: {
          segmentIds: events.map((e) => e.id),
          text: events.map((e) => e.text).join(' '),
          startMs: Math.min(...events.map((e) => e.startMs)),
          endMs: Math.max(...events.map((e) => e.endMs)),
        },
        ...(options.contextBudgetBytes !== undefined
          ? { budgetBytes: options.contextBudgetBytes }
          : {}),
      });
    } catch (error) {
      if (error instanceof ContextError && error.code === 'INTERACTION_ACTIVE') return;
      blocked = true;
      clearTimer();
      diagnostic(
        'session.context_blocked',
        {
          code: error instanceof ContextError ? error.code : 'unexpected_error',
        },
        true,
      );
      publish({
        generation: 'paused',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const ids = new Set(request.transcript.segmentIds);
    const events = [...state.transcript].filter((event) => ids.has(event.id));
    if (!continuation) queue = [];
    ready = false;
    clearTimer();
    run({ request, events, started: now(), version }, false);
  };
  const scheduleFollowup = () => {
    if (followup || disposed) return;
    followup = true;
    queueMicrotask(() => {
      followup = false;
      if (!disposed) pump();
    });
  };
  const pauseIntake = (message: string) => {
    limited = true;
    speech.pause();
    backendSpeech?.pause();
    microphone.pause();
    publish({ capture: 'paused', message });
  };
  const ingest = (input: unknown): boolean => {
    if (disposed || paused || stopped || limited) return false;
    const parsed = speechEventSchema.safeParse(input);
    if (!parsed.success || !parsed.data.text.trim()) {
      publish({
        message:
          'Invalid transcript segment. Correct its text, ID or timestamps before resubmitting.',
      });
      return false;
    }
    const event = parsed.data;
    if (state.mode === 'backend' && !event.isFinal) return true;
    const prior = finalized.get(event.id);
    if (prior) {
      if (!event.isFinal || JSON.stringify(prior) === JSON.stringify(event)) return true;
      publish({
        message:
          'A finalized transcript ID was reused with different content. Use a new segment ID for corrections.',
      });
      return false;
    }
    if (!event.isFinal) {
      publish({ interim: event });
      return true;
    }
    const events = [...queue.map((q) => q.event), event];
    const chars = events.map((e) => e.text).join(' ').length;
    const duration =
      Math.max(...events.map((e) => e.endMs)) - Math.min(...events.map((e) => e.startMs));
    if (chars > maxChars || duration > maxDuration) {
      pauseIntake(
        `Transcript intake paused at the ${maxChars}-character/${maxDuration / 1000}-second queue limit. Send queued text, then Resume; the source retains the unaccepted segment. Split an individually oversized segment.`,
      );
      return false;
    }
    finalized.set(event.id, event);
    queue.push({ event, enqueuedAt: now() });
    const history = [...state.transcript, { ...event, status: 'queued' as const }];
    const excess = Math.max(0, history.length - 200);
    publish({
      interim: state.interim?.id === event.id ? null : state.interim,
      transcript: history.slice(excess),
      hiddenTranscriptCount: state.hiddenTranscriptCount + excess,
      generation: active ? 'streaming' : failed ? 'error' : blocked ? 'paused' : 'queued',
    });
    if (active) ready = true;
    else if (!timer && !ready && !failed && !blocked)
      timer = setTimeout(() => {
        timer = undefined;
        ready = true;
        pump();
      }, groupMs);
    if (chars === maxChars || duration === maxDuration)
      pauseIntake(
        'Transcript queue reached its limit. Intake paused; send queued text, then Resume.',
      );
    return true;
  };
  const beginSpeech = () => {
    const token = ++captureToken;
    currentSpeech().start(
      (event) => token === captureToken && ingest(event),
      (capture) => {
        if (!disposed && token === captureToken && state.mode !== 'microphone' && !stopped)
          publish({
            capture,
            ...(['error', 'finishing', 'paused'].includes(capture) ? { holdActive: false } : {}),
          });
      },
    );
  };
  const start = async (mode: SessionMode = state.mode) => {
    if (disposed || (active && mode !== state.mode)) return;
    if (limited && queue.length) {
      publish({ message: 'Send the queued transcript before resuming intake.' });
      return;
    }
    if (state.capture === 'recording' || state.capture === 'requesting') return;
    paused = false;
    stopped = false;
    limited = false;
    if (state.mode !== mode) {
      captureToken++;
      speech.stop();
      backendSpeech?.stop();
      microphone.stop();
    }
    publish({
      mode,
      ...(mode !== 'backend' && state.mode === 'backend' ? { sessionId: newId() } : {}),
      message: '',
      generation: failed ? 'error' : queue.length ? 'queued' : 'idle',
    });
    if (mode === 'backend') {
      const token = ++captureToken;
      const epoch = options.store.getSessionEpoch();
      publish({ capture: 'requesting' });
      try {
        if (!options.backend) throw new Error('Backend mode is unavailable');
        const identity = await options.backend.ensure(epoch);
        if (disposed || token !== captureToken || epoch !== options.store.getSessionEpoch()) return;
        publish({ sessionId: identity.sessionId, epoch });
      } catch (error) {
        if (!disposed && token === captureToken)
          publish({ capture: 'error', generation: 'paused', message: String(error) });
        return;
      }
    }
    if (mode === 'microphone') {
      const token = ++captureToken;
      if (microphone.getSnapshot().state === 'paused') microphone.resume();
      else await microphone.start();
      if (disposed || token !== captureToken || microphone.getSnapshot().state !== 'recording')
        return;
    }
    beginSpeech();
    if (queue.length) {
      ready = true;
      pump();
    }
  };
  const beginHold = async () => {
    if (disposed || state.holdActive || state.capture === 'finishing') return;
    const version = ++holdVersion;
    holdStarted = now();
    publish({ holdActive: true, holdElapsedMs: 0 });
    await start('backend');
    if (version !== holdVersion || !state.holdActive) return;
    if (!['recording', 'requesting'].includes(state.capture)) publish({ holdActive: false });
  };
  const releaseHold = async () => {
    if (!state.holdActive) return;
    holdVersion++;
    publish({ holdActive: false, holdElapsedMs: Math.max(0, now() - holdStarted) });
    // Cancel a pending session connection. Once recording has started, preserve
    // its callback token until all finalized tail chunks have been delivered.
    if (!backendSpeech) return;
    if (state.capture === 'requesting') captureToken++;
    await backendSpeech.finish();
    if (disposed) return;
    ready = true;
    clearTimer();
    pump(true);
  };
  const cancelHold = () => {
    holdVersion++;
    captureToken++;
    backendSpeech?.stop();
    publish({
      holdActive: false,
      capture: 'idle',
      message: 'Unsent audio cancelled. Earlier drawing updates are kept.',
    });
  };
  const pause = () => {
    if (disposed) return;
    paused = true;
    captureToken++;
    clearTimer();
    speech.pause();
    backendSpeech?.pause();
    if (microphone.getSnapshot().state === 'requesting') microphone.stop();
    else microphone.pause();
    publish({
      capture: 'paused',
      generation: active ? 'streaming' : 'paused',
      message: 'Input paused. The current generation may finish.',
    });
  };
  const stop = () => {
    holdVersion++;
    publish({ holdActive: false });
    if (disposed) return;
    stopped = true;
    paused = true;
    captureToken++;
    clearTimer();
    speech.stop();
    backendSpeech?.stop();
    microphone.stop();
    options.consumer.cancel('Session stopped');
    publish({
      capture: 'idle',
      interim: null,
      generation: active ? 'streaming' : failed ? 'error' : 'paused',
      message: 'Stopped. Applied drawing and unsent transcript are retained.',
    });
  };
  const unsubscribeEpoch = options.store.subscribeSessionInvalidation((epoch) => {
    holdVersion++;
    publish({ holdActive: false });
    const replacing = replacementVersion !== options.store.getReplacementVersion();
    replacementVersion = options.store.getReplacementVersion();
    const interrupted = active?.events ?? [];
    version++;
    captureToken++;
    clearTimer();
    speech.stop();
    speech.reset?.();
    backendSpeech?.stop();
    backendSpeech?.reset();
    void options.backend?.reset(epoch);
    microphone.stop();
    options.consumer.cancel('Session epoch changed');
    if (replacing) queue = [];
    active = null;
    failed = null;
    deferred.clear();
    if (replacing) finalized.clear();
    paused = !replacing;
    stopped = !replacing;
    limited = false;
    blocked = false;
    ready = false;
    publish({
      sessionId: newId(),
      epoch,
      capture: 'idle',
      generation: replacing ? 'idle' : 'paused',
      interim: null,
      transcript: replacing ? [] : mark(interrupted, 'failed'),
      hiddenTranscriptCount: replacing ? 0 : state.hiddenTranscriptCount,
      inspector: replacing ? null : state.inspector,
      lastResult: null,
      modelLatencyMs: null,
      message: replacing
        ? 'Session cleared after document replacement.'
        : 'Generation epoch changed. Partial work and unsent transcript are retained; Send now starts a fresh request for queued text. Interrupted segments are not automatically replayed.',
    });
  });
  const unsubscribeEditor = options.subscribeInteraction?.(scheduleFollowup) ?? (() => {});
  const unsubscribeStream = options.consumer.subscribe(scheduleFollowup);
  const unsubscribeMic = microphone.subscribe(() => {
    if (state.mode !== 'microphone') return;
    const mic = microphone.getSnapshot();
    if (mic.state === 'error') {
      captureToken++;
      speech.stop();
    }
    // Capture diagnostics have their own panel; do not hide generation/queue errors.
    publish({ capture: mic.state });
  });
  const unsubscribeAudioProgress =
    backendSpeech?.subscribeProgress(() => {
      publish({ transcribingAudio: backendSpeech.getTranscribing() });
    }) ?? (() => {});
  const ageTimer = setInterval(() => {
    if (queue.length || active || state.holdActive) publish();
  }, 250);
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    microphone,
    beginHold,
    releaseHold,
    cancelHold,
    ingest,
    start,
    pause,
    resume: () => start(state.mode),
    stop,
    sendNow: () => {
      if (disposed) return;
      blocked = false;
      ready = true;
      clearTimer();
      pump(true);
    },
    continueFresh: () => {
      if (disposed || active || !failed || state.mode !== 'backend') return;
      blocked = false;
      pump(true, failed);
    },
    retry: () => {
      if (disposed || active || !failed) return;
      if (failed.request.sessionEpoch !== options.store.getSessionEpoch()) {
        publish({ generation: 'error', message: 'Original request belongs to an obsolete epoch.' });
        return;
      }
      if (options.getContext().interactionInProgress) {
        publish({ message: 'Finish the active edit, then Retry.' });
        return;
      }
      run(failed, true);
    },
    reset: (confirmation: { confirmed: boolean }) => {
      if (disposed || !confirmation.confirmed) return false;
      return options.store.reset().status === 'applied';
    },
    dispose: () => {
      if (disposed) return;
      stop();
      version++;
      disposed = true;
      clearTimer();
      clearInterval(ageTimer);
      unsubscribeEpoch();
      unsubscribeEditor();
      unsubscribeStream();
      unsubscribeMic();
      unsubscribeAudioProgress();
      speech.dispose();
      microphone.dispose();
      listeners.clear();
    },
  };
}
export type SessionController = ReturnType<typeof createSessionController>;
