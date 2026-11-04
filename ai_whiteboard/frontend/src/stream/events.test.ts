import { describe, expect, it } from 'vitest';
import type { GenerationEvent, GenerationTransport } from '../contracts';
import { setup } from '../scene/test-helpers';
import { createStreamConsumer } from './consumer';
import { requestFor } from './test-helpers';

function transport(events: GenerationEvent[]): GenerationTransport {
  return {
    async *generate() {
      yield* events;
    },
  };
}

describe('typed generation event boundary', () => {
  const base = { wireVersion: 1 as const, requestId: 'r1', sessionEpoch: 0 };
  const operation: GenerationEvent = {
    ...base,
    event: 'operation',
    sequence: 7,
    baseRevision: 0,
    operation: { op: 'section.add', id: 'g_r1_topic', title: 'Topic' },
  };
  const completed: GenerationEvent = {
    ...base,
    event: 'completed',
    sequence: 8,
    operationCount: 1,
    warningCount: 0,
  };

  it('dispatches the original sequence through replay without renumbering', async () => {
    const { store } = setup();
    const sequences: number[] = [];
    const consumer = createStreamConsumer({
      store,
      onOperation: (e) => sequences.push(e.sequence),
    });
    const request = requestFor(store);
    expect((await consumer.consume(request, transport([operation, completed]))).phase).toBe(
      'completed',
    );
    expect(sequences).toEqual([7]);
    expect(store.getOperationResult('r1', 7)?.status).toBe('applied');
    const replay = await consumer.consume(request, transport([operation, completed]), {
      retry: true,
    });
    expect(replay.stats.duplicates).toBe(1);
  });

  it('retains accepted operations when EOF has no terminal event', async () => {
    const { store } = setup();
    const result = await createStreamConsumer({ store }).consume(
      requestFor(store),
      transport([operation]),
    );
    expect(result.phase).toBe('error');
    expect(result.stats.applied).toBe(1);
    expect(result.diagnostics[0]?.message).toContain('terminal');
  });

  it('rejects stale metadata and events after a terminal', async () => {
    for (const events of [
      [{ ...operation, sessionEpoch: 99 }],
      [{ ...operation, requestId: 'other' }],
      [{ ...operation, baseRevision: 99 }],
      [operation, { ...completed, sequence: 7 }],
      [operation, completed, { ...operation, sequence: 9 }],
    ]) {
      const { store } = setup();
      const result = await createStreamConsumer({ store }).consume(
        requestFor(store),
        transport(events),
      );
      expect(result.phase).toBe('error');
    }
  });

  it('surfaces provider failure and preserves its validated prefix', async () => {
    const { store } = setup();
    const result = await createStreamConsumer({ store }).consume(
      requestFor(store),
      transport([
        operation,
        {
          ...base,
          event: 'failed',
          sequence: 8,
          code: 'provider_timeout',
          message: 'Provider timed out',
          retryable: false,
        },
      ]),
    );
    expect(result.phase).toBe('error');
    expect(result.stats.applied).toBe(1);
    expect(result.diagnostics[0]?.message).toBe('Provider timed out');
  });
});
