import { describe, expect, it } from 'vitest';
import { manualNodeId, setup } from '../scene/test-helpers';
import { requestFor } from './test-helpers';
import { createStreamConsumer } from './consumer';
import { MockGenerationTransport, RawMockFixtureTransport } from './mock';
import { buildDemoOperations } from './fixtures';
import { namespaceOperation } from './namespace';
import { operationSchema } from '../contracts';

describe('seeded transport and context fixtures', () => {
  it('reproduces seeded byte fragmentation, CRLF and a final record without LF', async () => {
    const { store } = setup();
    const request = requestFor(store);
    const read = async () => {
      const chunks = [];
      for await (const chunk of new RawMockFixtureTransport({
        seed: 3,
        lineEnding: '\r\n',
        finalNewline: false,
        lineDelayMs: 0,
        tailDelayMs: 0,
      }).generate(request, new AbortController().signal))
        chunks.push([...chunk]);
      return chunks;
    };
    const first = await read();
    expect(first).toEqual(await read());
    const text = new TextDecoder().decode(new Uint8Array(first.flat()));
    expect(text).toContain('\r\n');
    expect(text.endsWith('\n')).toBe(false);
    expect(new Set(first.map((c) => c.length)).size).toBeGreaterThan(1);
  });
  it('references existing generated nodes and a manual database without duplicating context objects', async () => {
    const { store, manual } = setup();
    const consumer = createStreamConsumer({ store });
    expect(
      (
        await consumer.consume(
          requestFor(store),
          new MockGenerationTransport({ lineDelayMs: 0, tailDelayMs: 0 }),
        )
      ).phase,
    ).toBe('completed');
    const section = Object.keys(store.getSnapshot().sections)[0]!;
    store.dispatch(
      {
        op: 'node.add',
        id: manualNodeId,
        section,
        type: 'ellipse',
        label: 'Database',
        at: [600, 500],
      },
      manual(),
    );
    const next = requestFor(store, {
      requestId: 'r2',
      idPrefix: 'g_r2_',
      transcript: {
        segmentIds: ['demo-database'],
        text: 'Server queries the database',
        startMs: 2000,
        endMs: 3000,
      },
    });
    const operations = buildDemoOperations(next);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ op: 'edge.add', from: 'g_r1_server', to: manualNodeId });
    expect(
      (
        await consumer.consume(
          next,
          new MockGenerationTransport({ lineDelayMs: 0, tailDelayMs: 0 }),
        )
      ).phase,
    ).toBe('completed');
    expect(Object.keys(store.getSnapshot().nodes)).toHaveLength(3);
    expect(
      namespaceOperation(
        operationSchema.parse({
          op: 'node.add',
          id: 'new',
          section,
          type: 'rect',
          label: 'New',
          place: { below: manualNodeId },
        }),
        next,
      ),
    ).toMatchObject({ id: 'g_r2_new', section, place: { below: manualNodeId } });
  });
  it('uses explicit segment IDs, supports malformed records, and never infers topics from prose', async () => {
    const { store } = setup();
    expect(
      buildDemoOperations(
        requestFor(store, {
          transcript: {
            segmentIds: ['unknown'],
            text: 'new topic Browser Server',
            startMs: 0,
            endMs: 1,
          },
        }),
      ),
    ).toEqual([]);
    const result = await createStreamConsumer({ store }).consume(
      requestFor(store),
      new MockGenerationTransport({ malformedAfterRecord: 0, lineDelayMs: 0, tailDelayMs: 0 }),
    );
    expect(result.phase).toBe('incomplete');
    expect(result.stats).toMatchObject({ applied: 4, invalid: 1 });
  });
  it('propagates abort through an outstanding delay without yielding later bytes', async () => {
    const { store } = setup();
    const controller = new AbortController();
    const transport = new RawMockFixtureTransport({
      minChunkBytes: 1,
      maxChunkBytes: 1,
      burstSize: 1,
      delayMs: 10000,
    });
    const stream = transport.generate(requestFor(store), controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    const waiting = iterator.next();
    controller.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
    expect((await iterator.next()).done).toBe(true);
  });
  it('rejects invalid mock options', () => {
    for (const options of [
      { minChunkBytes: 0 },
      { maxChunkBytes: 0 },
      { burstSize: 0 },
      { delayMs: -1 },
      { disconnectAfterBytes: -1 },
    ])
      expect(() => new MockGenerationTransport(options)).toThrow();
  });
});
