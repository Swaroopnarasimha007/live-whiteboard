import { describe, expect, it, vi } from 'vitest';
import type { GenerationEvent, GenerationRequest } from '../../contracts';
import { HttpGenerationTransport } from './transport';

const request = {
  requestId: 'r1',
  sessionId: 'bs_test',
  sessionEpoch: 3,
  baseRevision: 7,
} as GenerationRequest;
const base = { wireVersion: 1 as const, requestId: 'r1', sessionEpoch: 3 };
const started = { ...base, event: 'started' as const, baseRevision: 7, sequence: 1 };
const warning = {
  ...base,
  event: 'warning' as const,
  code: 'notice',
  message: 'नमस्ते café',
  sequence: 2,
};
const completed = {
  ...base,
  event: 'completed' as const,
  operationCount: 0,
  warningCount: 1,
  sequence: 3,
};
const bytes = (events: unknown[]) =>
  new TextEncoder().encode(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
function response(data: Uint8Array, split = 1) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < data.length; i += split) controller.enqueue(data.slice(i, i + split));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/x-ndjson' } },
  );
}
async function collect(events: AsyncIterable<GenerationEvent>) {
  const result = [];
  for await (const event of events) result.push(event);
  return result;
}
describe('HTTP generation transport', () => {
  it('decodes split UTF-8 and envelopes without changing sequences or IDs', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(bytes([started, warning, completed])));
    const transport = new HttpGenerationTransport('http://backend', fetcher);
    expect(await collect(transport.generate(request, new AbortController().signal))).toEqual([
      started,
      warning,
      completed,
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual(request);
  });
  it('replays an original sequence suffix through GET', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(bytes([warning, completed]), 17));
    expect(
      await collect(
        new HttpGenerationTransport('http://backend', fetcher).replay(
          request,
          1,
          new AbortController().signal,
        ),
      ),
    ).toEqual([warning, completed]);
    expect(fetcher.mock.calls[0]![0]).toContain(
      '/r1/events?sessionId=bs_test&sessionEpoch=3&after=1',
    );
  });
  it.each([
    [started],
    [started, { ...warning, sequence: 8 }, completed],
    [started, { ...warning, requestId: 'other' }, completed],
    [started, { ...warning, sessionEpoch: 4 }, completed],
    [{ ...started, baseRevision: 8 }, completed],
    [started, warning, completed, completed],
    [warning, completed],
  ])('rejects incomplete or conflicting stream %j', async (...events) => {
    const transport = new HttpGenerationTransport(
      'http://backend',
      vi.fn<typeof fetch>().mockResolvedValue(response(bytes(events))),
    );
    await expect(
      collect(transport.generate(request, new AbortController().signal)),
    ).rejects.toThrow();
  });
  it('reports unknown replay as actionable HTTP 410, without generating', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'replay_expired', message: 'Use a new request with fresh context.' },
        }),
        { status: 410 },
      ),
    );
    await expect(
      collect(
        new HttpGenerationTransport('http://backend', fetcher).replay(
          request,
          0,
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ status: 410, code: 'replay_expired' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('abort sends an explicit bounded cancellation and releases the reader', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes([started]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }),
      )
      .mockResolvedValue(new Response('{}'));
    const abort = new AbortController();
    const stream = new HttpGenerationTransport('http://backend', fetcher).generate(
      request,
      abort.signal,
    );
    const events = stream[Symbol.asyncIterator]();
    expect((await events.next()).value).toEqual(started);
    abort.abort();
    await expect(events.next()).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(fetcher.mock.calls[1]![0]).toContain('/r1/cancel');
  });
  it('rejects invalid UTF-8 and bounded oversized records', async () => {
    for (const data of [new Uint8Array([0xff]), new TextEncoder().encode('x'.repeat(262145))]) {
      const transport = new HttpGenerationTransport(
        'http://backend',
        vi.fn<typeof fetch>().mockResolvedValue(response(data, data.length)),
      );
      await expect(
        collect(transport.generate(request, new AbortController().signal)),
      ).rejects.toThrow();
    }
  });
});
