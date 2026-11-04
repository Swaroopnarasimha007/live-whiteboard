import { adaptRawFixtureTransport } from './rawFixture';
import { describe, expect, it } from 'vitest';
import { setup } from '../scene/test-helpers';
import { createStreamConsumer } from './consumer';
import { MockGenerationTransport } from './mock';
import { bytesTransport, requestFor } from './test-helpers';

const section = { op: 'section.add', id: 'topic', title: 'Flow' };
const node = { op: 'node.add', id: 'a', section: 'topic', type: 'rect', label: 'café 🌍' };
const encode = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n');
const fast = { lineDelayMs: 0, tailDelayMs: 0, burstSize: 1000 };

describe('stream consumer integration', () => {
  it('recovers malformed JSON, schema and markdown records and accepts a final Unicode record without LF', async () => {
    const { store } = setup();
    const consumer = createStreamConsumer({ store });
    const result = await consumer.consume(
      requestFor(store),
      bytesTransport(`${encode(section)}\n{bad\n{}\n\x60\x60\x60json\n\n${encode(node)}`, 1),
    );
    expect(result.phase).toBe('incomplete');
    expect(result.stats).toMatchObject({ applied: 2, invalid: 3, records: 5 });
    expect(store.getSnapshot().nodes.g_r1_a?.label).toBe('café 🌍');
    expect(result.diagnostics.map((d) => d.code)).toEqual(['JSON', 'SCHEMA', 'MARKDOWN']);
  });
  it('resolves edges queued before endpoints and reports their eventual results', async () => {
    const { store } = setup();
    const result = await createStreamConsumer({ store }).consume(
      requestFor(store),
      bytesTransport(
        encode(section, { op: 'edge.add', id: 'e', section: 'topic', from: 'a', to: 'b' }, node, {
          ...node,
          id: 'b',
        }),
      ),
    );
    expect(result.phase).toBe('completed');
    expect(result.stats).toMatchObject({ applied: 4, pending: 0 });
    expect(store.getSnapshot().edges.g_r1_e?.from).toBe('g_r1_a');
  });
  it('applies on a frame while transport remains open; cancellation settles a non-cooperating read', async () => {
    const { store } = setup();
    const consumer = createStreamConsumer({ store });
    const task = consumer.consume(
      requestFor(store),
      adaptRawFixtureTransport({
        async *generate() {
          yield new TextEncoder().encode(encode(section) + '\n');
          await new Promise(() => {});
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getSnapshot().sections.g_r1_topic).toBeDefined();
    expect(consumer.getSnapshot().phase).toBe('receiving');
    consumer.cancel();
    expect((await task).phase).toBe('cancelled');
    const revision = store.getSnapshot().revision;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.getSnapshot().revision).toBe(revision);
  });
  it('aborts overflow visibly and drains the accepted prefix without losing operations', async () => {
    const { store } = setup();
    const result = await createStreamConsumer({ store, maxQueue: 2 }).consume(
      requestFor(store),
      bytesTransport(encode(section, node, { ...node, id: 'b' }), 10000),
    );
    expect(result.phase).toBe('error');
    expect(result.diagnostics[0]?.code).toBe('QUEUE_LIMIT');
    expect(result.stats.applied).toBe(2);
    expect(Object.keys(store.getSnapshot().nodes)).toEqual(['g_r1_a']);
  });
  it('preserves a disconnected prefix and only replays on explicit retry with stable identities', async () => {
    const { store } = setup();
    const consumer = createStreamConsumer({ store });
    const request = requestFor(store);
    const fixture = [section, node];
    const firstLine = new TextEncoder().encode(JSON.stringify(section) + '\n').length;
    const failed = await consumer.consume(
      request,
      new MockGenerationTransport({ ...fast, fixture, disconnectAfterBytes: firstLine }),
    );
    expect(failed.phase).toBe('error');
    expect(failed.stats.applied).toBe(1);
    expect(
      (await consumer.consume(request, new MockGenerationTransport({ ...fast, fixture }))).phase,
    ).toBe('error');
    const retried = await consumer.consume(
      request,
      new MockGenerationTransport({ ...fast, fixture }),
      { retry: true },
    );
    expect(retried.phase).toBe('completed');
    expect(retried.stats).toMatchObject({ applied: 1, duplicates: 1 });
    expect(Object.keys(store.getSnapshot().sections)).toHaveLength(1);
  });
  it('aborts oversized partial records and retains earlier valid operations', async () => {
    const { store } = setup();
    const result = await createStreamConsumer({
      store,
    }).consume(
      requestFor(store),
      bytesTransport(encode(section) + '\n' + 'x'.repeat(201), 10, {
        maxLineBytes: 100,
        maxPartialBytes: 200,
      }),
    );
    expect(result.phase).toBe('error');
    expect(result.diagnostics[0]?.code).toBe('BUFFER_LIMIT');
    expect(result.stats.applied).toBe(1);
  });
  it('cancels queued frames on reset and prevents late writes', async () => {
    const { store } = setup();
    const consumer = createStreamConsumer({ store });
    const task = consumer.consume(
      requestFor(store),
      adaptRawFixtureTransport({
        async *generate() {
          yield new TextEncoder().encode(encode(section) + '\n');
          await new Promise(() => {});
        },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    store.reset();
    expect((await task).phase).toBe('cancelled');
    expect(Object.keys(store.getSnapshot().sections)).toHaveLength(0);
  });
  it('defers requests during manual interactions and rejects concurrent consumption', async () => {
    const { store } = setup();
    const request = requestFor(store);
    const blocked = await createStreamConsumer({
      store,
      isInteractionInProgress: () => true,
    }).consume(request, bytesTransport(''));
    expect(blocked.diagnostics[0]?.code).toBe('INTERACTION_ACTIVE');
    const consumer = createStreamConsumer({ store });
    const running = consumer.consume(
      request,
      adaptRawFixtureTransport({
        async *generate() {
          await new Promise(() => {});
          yield new Uint8Array();
        },
      }),
    );
    expect((await consumer.consume(request, bytesTransport(''))).diagnostics[0]?.code).toBe('BUSY');
    consumer.dispose();
    expect((await running).phase).toBe('cancelled');
  });
  it('validates limits before opening requests and isolates throwing observers', async () => {
    const { store } = setup();
    expect(() => createStreamConsumer({ store, maxQueue: 0 })).toThrow();
    const consumer = createStreamConsumer({
      store,
      onOperation() {
        throw new Error('observer');
      },
    });
    consumer.subscribe(() => {
      throw new Error('listener');
    });
    expect((await consumer.consume(requestFor(store), bytesTransport(encode(section)))).phase).toBe(
      'completed',
    );
  });
  it('reopens unresolved dependencies on explicit retry, keeping accepted receipts deduplicated', async () => {
    const { store } = setup();
    const consumer = createStreamConsumer({ store });
    const request = requestFor(store);
    const edge = { op: 'edge.add', id: 'e', section: 'topic', from: 'a', to: 'b' };
    const fixture = [section, edge, node, { ...node, id: 'b' }];
    const cutoff = new TextEncoder().encode(encode(section, edge) + '\n').length;
    const first = await consumer.consume(
      request,
      new MockGenerationTransport({ ...fast, fixture, disconnectAfterBytes: cutoff }),
    );
    expect(first.stats).toMatchObject({ applied: 1, rejected: 1, pending: 0 });
    const retry = await consumer.consume(
      request,
      new MockGenerationTransport({ ...fast, fixture }),
      { retry: true },
    );
    expect(retry.phase).toBe('completed');
    expect(retry.stats).toMatchObject({ duplicates: 1, applied: 3, pending: 0 });
  });
  it('protects a manual edit made after disconnect when replaying the original request', async () => {
    const { store, manual } = setup();
    const consumer = createStreamConsumer({ store });
    const request = requestFor(store);
    const fixture = [
      section,
      node,
      { op: 'node.update', id: 'a', set: { label: 'Generated correction' } },
    ];
    const cutoff = new TextEncoder().encode(encode(section, node) + '\n').length;
    await consumer.consume(
      request,
      new MockGenerationTransport({ ...fast, fixture, disconnectAfterBytes: cutoff }),
    );
    store.dispatch(
      { op: 'node.update', id: 'g_r1_a', set: { label: 'Manual correction' } },
      manual(),
    );
    const retry = await consumer.consume(
      request,
      new MockGenerationTransport({ ...fast, fixture }),
      { retry: true },
    );
    expect(retry.phase).toBe('incomplete');
    expect(retry.stats).toMatchObject({ duplicates: 2, rejected: 1 });
    expect(store.getSnapshot().nodes.g_r1_a?.label).toBe('Manual correction');
  });
  it('observes generation-only epoch invalidation even with no scene notification', async () => {
    const { store } = setup();
    const consumer = createStreamConsumer({ store });
    const task = consumer.consume(
      requestFor(store),
      adaptRawFixtureTransport({
        async *generate() {
          await new Promise(() => {});
          yield new Uint8Array();
        },
      }),
    );
    store.cancelGeneration();
    expect((await task).phase).toBe('cancelled');
  });
  it('discards queued operations if an external signal is aborted before the next frame', async () => {
    const { store } = setup();
    const controller = new AbortController();
    const consumer = createStreamConsumer({ store });
    const task = consumer.consume(
      requestFor(store),
      adaptRawFixtureTransport({
        async *generate() {
          yield new TextEncoder().encode(encode(section) + '\n');
          controller.abort();
        },
      }),
      { signal: controller.signal },
    );
    const result = await task;
    expect(result.phase).toBe('cancelled');
    expect(result.stats.discarded).toBe(1);
    expect(store.getSnapshot().revision).toBe(0);
  });
});
