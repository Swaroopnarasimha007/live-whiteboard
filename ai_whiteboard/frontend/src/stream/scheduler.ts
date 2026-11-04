import { STREAM_LIMITS, StreamError } from './types';

export interface FrameClock {
  now(): number;
  request(callback: () => void): number;
  cancel(id: number): void;
}
export function defaultFrameClock(): FrameClock {
  if (typeof requestAnimationFrame === 'function')
    return {
      now: () => performance.now(),
      request: (cb) => requestAnimationFrame(cb),
      cancel: (id) => cancelAnimationFrame(id),
    };
  return {
    now: () => performance.now(),
    request: (cb) => Number(setTimeout(cb, 0)),
    cancel: (id) => clearTimeout(id),
  };
}
export interface FrameSchedulerOptions<T> {
  apply(item: T): void;
  clock?: FrameClock;
  budgetMs?: number;
  maxQueue?: number;
  onFrame?: (event: { processed: number; queued: number; elapsedMs: number }) => void;
  onError?: (error: unknown) => void;
}
export function createFrameScheduler<T>(options: FrameSchedulerOptions<T>) {
  const clock = options.clock ?? defaultFrameClock();
  const budget = options.budgetMs ?? STREAM_LIMITS.frameMs;
  const max = options.maxQueue ?? STREAM_LIMITS.queue;
  if (
    !Number.isFinite(budget) ||
    budget <= 0 ||
    budget > STREAM_LIMITS.frameMs ||
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > STREAM_LIMITS.queue
  )
    throw new Error('Invalid frame scheduler limits');
  let queue: T[] = [];
  let head = 0;
  let frame: number | undefined;
  let closed = false;
  let error: unknown;
  const waiters: { resolve(): void; reject(reason: unknown): void }[] = [];
  const count = () => queue.length - head;
  const settle = () => {
    for (const waiter of waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  };
  const schedule = () => {
    if (frame === undefined && count() && !closed) frame = clock.request(drain);
  };
  const drain = () => {
    frame = undefined;
    if (closed) return;
    const start = clock.now();
    let processed = 0;
    try {
      while (count() && (processed === 0 || clock.now() - start < budget) && !closed) {
        const item = queue[head++]!;
        options.apply(item);
        processed++;
      }
      if (head === queue.length) {
        queue = [];
        head = 0;
      } else if (head > 1_024) {
        queue = queue.slice(head);
        head = 0;
      }
      options.onFrame?.({ processed, queued: count(), elapsedMs: clock.now() - start });
    } catch (caught) {
      error = caught;
      closed = true;
      options.onError?.(caught);
    }
    if (closed || !count()) settle();
    else schedule();
  };
  return {
    enqueue(item: T) {
      if (closed) throw new StreamError('SCHEDULER', 'Frame scheduler is closed');
      if (count() >= max)
        throw new StreamError(
          'QUEUE_LIMIT',
          `Ready-operation queue exceeds ${max}; request aborted without dropping accepted work`,
        );
      queue.push(item);
      schedule();
    },
    whenIdle: (): Promise<void> =>
      error
        ? Promise.reject(error)
        : !count() && frame === undefined
          ? Promise.resolve()
          : new Promise((resolve, reject) => waiters.push({ resolve, reject })),
    cancel() {
      const discarded = count();
      closed = true;
      if (frame !== undefined) clock.cancel(frame);
      frame = undefined;
      queue = [];
      head = 0;
      settle();
      return discarded;
    },
    getQueueLength: count,
  };
}
