import {
  generationRequestSchema,
  generationEventSchema,
  type GenerationEvent,
  type ApplyResult,
  type GenerationTransport,
  type Operation,
} from '../contracts';
import type { SceneStore } from '../scene';
import { diagnostic } from '../diagnostics';
import { createFrameScheduler, defaultFrameClock, type FrameClock } from './scheduler';
import {
  freeze,
  STREAM_LIMITS,
  StreamError,
  type StreamDiagnostic,
  type StreamPhase,
  type StreamResult,
  type StreamSnapshot,
  type StreamStats,
} from './types';

export interface StreamConsumerOptions {
  store: SceneStore;
  clock?: FrameClock;
  maxQueue?: number;
  isInteractionInProgress?: () => boolean;
  onDiagnostic?: (diagnostic: StreamDiagnostic) => void;
  onOperation?: (event: { operation: Operation; sequence: number; result: ApplyResult }) => void;
}
export interface ConsumeOptions {
  signal?: AbortSignal;
  retry?: boolean;
}
const emptyStats = (): StreamStats => ({
  bytes: 0,
  records: 0,
  valid: 0,
  invalid: 0,
  applied: 0,
  duplicates: 0,
  rejected: 0,
  pending: 0,
  discarded: 0,
  queued: 0,
  frames: 0,
  firstAppliedMs: null,
  elapsedMs: 0,
});
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new StreamError('CANCELLED', 'Request cancelled'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

export function createStreamConsumer(options: StreamConsumerOptions) {
  // Validate configuration before any request can open or subscribe to the store.
  createFrameScheduler({
    apply() {},
    ...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
  });
  const clock = options.clock ?? defaultFrameClock();
  let snapshot: StreamSnapshot = freeze({
    phase: 'idle',
    requestId: null,
    stats: emptyStats(),
    diagnostics: [],
  });
  const listeners = new Set<() => void>();
  let disposed = false;
  let active: { cancel(reason: string): void } | null = null;
  const notify = (value: StreamSnapshot) => {
    if (disposed) return;
    snapshot = freeze(value);
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Observer cannot interrupt transport/store lifecycle. */
      }
    }
  };
  const consume = async (
    input: unknown,
    transport: GenerationTransport,
    consumeOptions: ConsumeOptions = {},
  ): Promise<StreamResult> => {
    const immediate = (code: StreamDiagnostic['code'], message: string): StreamResult => {
      diagnostic('consumer.preflight_rejected', { code }, true);
      return freeze({
        phase: 'error',
        requestId: null,
        stats: emptyStats(),
        diagnostics: [{ code, message }],
      });
    };
    if (disposed) return immediate('DISPOSED', 'Stream consumer is disposed');
    if (active) return immediate('BUSY', 'A generation request is already in flight');
    const parsed = generationRequestSchema.safeParse(input);
    if (!parsed.success) {
      const result = immediate('VALIDATION', parsed.error.message);
      notify(result);
      return result;
    }
    const request = freeze(parsed.data);
    diagnostic('consumer.start', {
      requestId: request.requestId,
      sessionEpoch: request.sessionEpoch,
      baseRevision: request.baseRevision,
      currentRevision: options.store.getSnapshot().revision,
      retry: !!consumeOptions.retry,
    });
    if (options.isInteractionInProgress?.()) {
      const result = immediate(
        'INTERACTION_ACTIVE',
        'Commit or cancel the active edit before creating a generation request',
      );
      notify(result);
      return result;
    }
    if (
      request.sessionEpoch !== options.store.getSessionEpoch() ||
      (!consumeOptions.retry && request.baseRevision !== options.store.getSnapshot().revision)
    ) {
      const result = immediate(
        'STALE_CONTEXT',
        'Request epoch/revision is stale; create a fresh context snapshot',
      );
      notify(result);
      return result;
    }
    const opened = options.store.beginRequest(
      request.requestId,
      request.sessionEpoch,
      !!consumeOptions.retry,
    );
    if (opened.status === 'rejected') {
      const result = immediate(opened.code, opened.message);
      notify(result);
      return result;
    }
    const controller = new AbortController();
    const stats = emptyStats();
    const issues: StreamDiagnostic[] = [];
    const started = clock.now();
    let phase: StreamPhase = 'receiving';
    let cancelled = false;
    let fatal = false;
    let sequence = 0;
    let lastPublish = -Infinity;
    const pending = new Map<number, Operation>();
    const publish = (force = true) => {
      if (!force && clock.now() - lastPublish < 16) return;
      lastPublish = clock.now();
      stats.elapsedMs = Math.max(0, clock.now() - started);
      notify({
        phase,
        requestId: request.requestId,
        stats: { ...stats },
        diagnostics: [...issues],
      });
    };
    const issue = (entry: StreamDiagnostic) => {
      diagnostic(
        'consumer.diagnostic',
        {
          requestId: request.requestId,
          code: entry.code,
          sequence: entry.sequence,
          line: entry.line,
        },
        entry.code !== 'CANCELLED',
      );
      issues.push(freeze(entry));
      if (issues.length > STREAM_LIMITS.diagnostics) issues.shift();
      try {
        options.onDiagnostic?.(entry);
      } catch {
        /* Diagnostics do not own the stream. */
      }
    };
    const outcome = (result: ApplyResult, seq: number, operation: Operation) => {
      if (result.status === 'applied') {
        stats.applied++;
        stats.firstAppliedMs ??= Math.max(0, clock.now() - started);
      } else if (result.status === 'duplicate') stats.duplicates++;
      else if (result.status === 'pending') pending.set(seq, operation);
      else if (result.status === 'rejected') {
        diagnostic(
          'consumer.operation_rejected',
          {
            requestId: request.requestId,
            sequence: seq,
            operation: operation.op,
            code: result.code,
            baseRevision: request.baseRevision,
            currentRevision: options.store.getSnapshot().revision,
          },
          true,
        );
        stats.rejected++;
        issue({ code: result.code, message: result.message, sequence: seq });
      }
      stats.pending = pending.size;
    };
    const reconcile = () => {
      for (const [seq, operation] of pending) {
        const result = options.store.getOperationResult(request.requestId, seq);
        if (result && result.status !== 'pending') {
          pending.delete(seq);
          outcome(result, seq, operation);
        }
      }
      stats.pending = pending.size;
    };
    const epochValid = () => request.sessionEpoch === options.store.getSessionEpoch();
    const scheduler = createFrameScheduler<{ operation: Operation; sequence: number }>({
      clock,
      ...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
      apply(item) {
        if (cancelled || disposed || !epochValid() || consumeOptions.signal?.aborted) {
          stats.discarded++;
          return;
        }
        const result = options.store.dispatch(item.operation, {
          source: 'generated',
          requestId: request.requestId,
          sequence: item.sequence,
          baseRevision: request.baseRevision,
          sessionEpoch: request.sessionEpoch,
          transactionId: `stream_${item.sequence}`,
        });
        outcome(result, item.sequence, item.operation);
        reconcile();
        try {
          options.onOperation?.({ ...item, result });
        } catch {
          /* Instrumentation is outside the dispatcher. */
        }
      },
      onFrame() {
        stats.frames++;
        stats.queued = scheduler.getQueueLength();
        reconcile();
        publish();
      },
      onError(error) {
        fatal = true;
        issue({
          code: 'SCHEDULER',
          message: error instanceof Error ? error.message : String(error),
        });
        stats.discarded += scheduler.cancel();
        controller.abort(error);
      },
    });
    const cancel = (reason: string) => {
      if (cancelled) return;
      cancelled = true;
      phase = 'cancelled';
      stats.discarded += scheduler.cancel();
      stats.queued = 0;
      issue({ code: 'CANCELLED', message: reason });
      controller.abort(new StreamError('CANCELLED', reason));
      publish();
    };
    active = { cancel };
    const parentAbort = () =>
      cancel(
        consumeOptions.signal?.reason instanceof Error
          ? consumeOptions.signal.reason.message
          : 'Request cancelled by caller',
      );
    consumeOptions.signal?.addEventListener('abort', parentAbort, { once: true });
    const unsubscribe = options.store.subscribeSessionInvalidation(() => {
      if (!epochValid()) cancel('Scene session changed; late request data ignored');
    });
    let terminal: GenerationEvent['event'] | null = null;
    let startedEvent = false;
    const acceptEvent = (input: GenerationEvent) => {
      const event = generationEventSchema.parse(input);
      if (event.requestId !== request.requestId || event.sessionEpoch !== request.sessionEpoch)
        throw new StreamError('TRANSPORT', 'Event request or epoch mismatch');
      if (terminal || event.sequence <= sequence)
        throw new StreamError(
          'TRANSPORT',
          'Events must have increasing original sequences and one terminal',
        );
      sequence = event.sequence;
      if ('baseRevision' in event && event.baseRevision !== request.baseRevision)
        throw new StreamError('TRANSPORT', 'Event base revision mismatch');
      if (event.event === 'started') {
        if (startedEvent) throw new StreamError('TRANSPORT', 'Duplicate started event');
        startedEvent = true;
      } else if (event.event === 'operation') {
        // Canonical IDs and original transport sequence arrive from the adapter.
        scheduler.enqueue({ operation: event.operation, sequence: event.sequence });
        stats.records++;
        stats.valid++;
        stats.queued = scheduler.getQueueLength();
      } else if (event.event === 'warning') {
        stats.records++;
        stats.invalid++;
        issue({
          code: event.code as StreamDiagnostic['code'],
          message: event.message,
          sequence: event.sequence,
        });
      } else {
        terminal = event.event;
        if (event.event === 'failed') {
          fatal = true;
          issue({
            code: event.code as StreamDiagnostic['code'],
            message: event.message,
            sequence: event.sequence,
          });
        } else if (event.event === 'cancelled') cancel(event.reason);
      }
    };
    let iterator: AsyncIterator<GenerationEvent> | undefined;
    let exhausted = false;
    publish();
    try {
      if (consumeOptions.signal?.aborted) parentAbort();
      if (cancelled) throw controller.signal.reason;
      iterator = transport.generate(request, controller.signal)[Symbol.asyncIterator]();
      while (true) {
        const next = await abortable(Promise.resolve(iterator.next()), controller.signal);
        if (cancelled || !epochValid()) {
          cancel('Obsolete or cancelled request');
          break;
        }
        if (next.done) {
          exhausted = true;
          if (!terminal)
            throw new StreamError('TRANSPORT', 'Stream ended without a terminal event');
          break;
        }
        stats.bytes += new TextEncoder().encode(JSON.stringify(next.value)).byteLength;
        acceptEvent(next.value);
        publish(false);
      }
    } catch (error) {
      if (!cancelled) {
        diagnostic(
          'consumer.transport_error',
          {
            requestId: request.requestId,
            errorType: error instanceof Error ? error.name : 'UnknownError',
            sequence,
          },
          true,
        );
        fatal = true;
        issue({
          code: error instanceof StreamError ? error.code : 'TRANSPORT',
          message: error instanceof Error ? error.message : String(error),
        });
        controller.abort(error);
      }
    }
    try {
      if (!cancelled && !disposed && epochValid()) {
        phase = 'draining';
        publish();
        await scheduler.whenIdle();
      } else {
        stats.discarded += scheduler.cancel();
        stats.queued = 0;
      }
    } catch (error) {
      fatal = true;
      issue({ code: 'SCHEDULER', message: error instanceof Error ? error.message : String(error) });
    } finally {
      scheduler.cancel();
      options.store.finishRequest(request.requestId);
      reconcile();
      if (cancelled || disposed) {
        stats.discarded += pending.size;
        pending.clear();
        stats.pending = 0;
      }
      unsubscribe();
      consumeOptions.signal?.removeEventListener('abort', parentAbort);
      if (!exhausted && iterator?.return) {
        try {
          void Promise.resolve(iterator.return()).catch(() => {});
        } catch {
          /* Best-effort cleanup of a non-cooperating transport. */
        }
      }
      phase =
        cancelled || disposed || !epochValid()
          ? 'cancelled'
          : fatal
            ? 'error'
            : stats.invalid || stats.rejected || stats.pending
              ? 'incomplete'
              : 'completed';
      stats.queued = 0;
      stats.elapsedMs = Math.max(0, clock.now() - started);
      active = null;
      publish();
      diagnostic(
        'consumer.end',
        {
          requestId: request.requestId,
          phase,
          terminal,
          applied: stats.applied,
          rejected: stats.rejected,
          invalid: stats.invalid,
          duplicates: stats.duplicates,
          pending: stats.pending,
          discarded: stats.discarded,
          elapsedMs: Math.round(stats.elapsedMs),
          diagnosticCodes: issues.map((item) => item.code).join(','),
        },
        phase === 'error' || phase === 'incomplete',
      );
    }
    return freeze({
      phase: phase as StreamResult['phase'],
      requestId: request.requestId,
      stats: { ...stats },
      diagnostics: [...issues],
    });
  };
  return {
    consume,
    isActive: () => active !== null,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel: (reason = 'Request cancelled') => active?.cancel(reason),
    dispose: () => {
      if (disposed) return;
      active?.cancel('Stream consumer disposed');
      disposed = true;
      snapshot = freeze({ ...snapshot, phase: 'disposed' });
      listeners.clear();
    },
  };
}
export type StreamConsumer = ReturnType<typeof createStreamConsumer>;
