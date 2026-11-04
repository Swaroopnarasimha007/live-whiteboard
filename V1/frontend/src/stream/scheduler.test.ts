import { expect, it } from 'vitest';
import { createFrameScheduler } from './scheduler';
import { frameClock } from './test-helpers';

it('processes within 8ms per frame, preserving every operation and order', async () => {
  const timer = frameClock();
  const applied: number[] = [];
  const scheduler = createFrameScheduler<number>({
    clock: timer.clock,
    apply: (n) => {
      applied.push(n);
      timer.cost(2);
    },
  });
  for (let i = 0; i < 10; i++) scheduler.enqueue(i);
  expect(timer.callbacks.size).toBe(1);
  timer.tick();
  expect(applied).toEqual([0, 1, 2, 3]);
  expect(timer.callbacks.size).toBe(1);
  timer.tick();
  expect(applied).toHaveLength(8);
  timer.tick();
  await scheduler.whenIdle();
  expect(applied).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
it('bounds ready work and reports overflow without discarding already accepted items', async () => {
  const timer = frameClock();
  const applied: number[] = [];
  const scheduler = createFrameScheduler<number>({
    clock: timer.clock,
    maxQueue: 2,
    apply: (n) => applied.push(n),
  });
  scheduler.enqueue(1);
  scheduler.enqueue(2);
  expect(() => scheduler.enqueue(3)).toThrow('queue exceeds 2');
  timer.tick();
  await scheduler.whenIdle();
  expect(applied).toEqual([1, 2]);
});
it('cancellation clears scheduled work and wakes idle waiters', async () => {
  const timer = frameClock();
  const applied: number[] = [];
  const scheduler = createFrameScheduler<number>({
    clock: timer.clock,
    apply: (n) => applied.push(n),
  });
  scheduler.enqueue(1);
  const idle = scheduler.whenIdle();
  expect(scheduler.cancel()).toBe(1);
  await idle;
  timer.tick();
  expect(applied).toEqual([]);
  expect(timer.callbacks.size).toBe(0);
});
it('reports an expensive single operation and makes progress rather than starving it', async () => {
  const timer = frameClock();
  let count = 0;
  const scheduler = createFrameScheduler<number>({
    clock: timer.clock,
    apply: () => {
      timer.cost(20);
      count++;
    },
  });
  scheduler.enqueue(1);
  scheduler.enqueue(2);
  timer.tick();
  expect(count).toBe(1);
  timer.tick();
  await scheduler.whenIdle();
  expect(count).toBe(2);
});
