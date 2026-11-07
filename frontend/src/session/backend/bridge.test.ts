import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendSessionBridge } from './bridge';
import { createRendererRuntime } from '../../app/rendererRuntime';
import type { GenerationRequest } from '../../contracts';

const caps = {
  protocolVersion: 1,
  wireVersion: 1,
  audioProtocolVersion: 1,
  transcriptionDefaultProfile: 'mock',
  transcriptionSelectionEnabled: true,
  transcriptionProfiles: [
    { id: 'mock', displayName: 'Mock', available: true },
    { id: 'india', displayName: 'India', available: true },
  ],
  diagramDefaultProfile: 'mock',
  diagramSelectionEnabled: false,
  diagramProfiles: [{ id: 'mock', displayName: 'Mock', available: true }],
  services: { sessions: true, audio: true, generation: true, replay: true },
};
const identity = (epoch = 0, id = 'bs_test') => ({
  sessionId: id,
  sessionEpoch: epoch,
  profile: 'mock',
  diagramProfile: 'mock',
  configurationFingerprint: 'fingerprint',
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
});
describe('backend session bridge', () => {
  it.each(['stale', 'expired', 'epoch', 'profile'] as const)(
    'clears a %s identity if replacement fails temporarily',
    async (reason) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json(caps))
        .mockResolvedValueOnce(json(identity()))
        .mockImplementation(async (_url, init) => {
          if (init?.method === 'DELETE') return new Response(null, { status: 204 });
          if (init?.method === 'GET')
            return json(
              {
                error: {
                  code: reason === 'stale' ? 'stale_epoch' : 'session_expired',
                  message: 'Gone',
                },
              },
              reason === 'stale' ? 409 : 410,
            );
          return json({ error: { code: 'unavailable', message: 'Busy' } }, 503);
        });
      const bridge = new BackendSessionBridge({ fetcher });
      cleanups.push(() => bridge.dispose());
      await bridge.ensure(0);
      if (reason === 'profile') bridge.select('profile', 'india');
      await expect(bridge.ensure(reason === 'epoch' ? 4 : 0)).rejects.toMatchObject({
        status: 503,
      });
      expect(bridge.getSnapshot()).toMatchObject({ identity: null, status: 'error' });
    },
  );
  it('does not delete the existing identity when ordinary reconnect fails temporarily', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(caps))
      .mockResolvedValueOnce(json(identity()))
      .mockResolvedValueOnce(json({ error: { code: 'unavailable', message: 'Busy' } }, 503))
      .mockImplementation(async (_url, init) =>
        init?.method === 'GET'
          ? json(identity())
          : json({ error: { code: 'session_limit', message: 'Full' } }, 429),
      );
    const bridge = new BackendSessionBridge({ fetcher });
    cleanups.push(() => bridge.dispose());
    await bridge.ensure(0);
    await expect(bridge.ensure(0)).rejects.toMatchObject({ status: 503 });
    expect(bridge.getSnapshot()).toMatchObject({ identity: identity(), status: 'error' });
    await expect(bridge.ensure(0)).resolves.toEqual(identity());
    expect(bridge.getSnapshot().status).toBe('ready');
    expect(fetcher.mock.calls[3]![0]).toContain('/sessions/bs_test?sessionEpoch=0');
    expect(fetcher.mock.calls[3]![1]?.method).toBe('GET');
    expect(fetcher.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false);
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });
  it('keeps a replacement identity when an old generation reports a late epoch error', async () => {
    let fail!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/capabilities')) return json(caps);
      if (String(url).endsWith('/generations'))
        return new Promise((resolve) => {
          fail = resolve;
        });
      if (String(url).endsWith('/reset')) return json(identity(1));
      if (init?.method === 'DELETE') return json({});
      return json(identity());
    });
    const bridge = new BackendSessionBridge({ fetcher });
    cleanups.push(() => bridge.dispose());
    await bridge.ensure(0);
    const events = bridge.transport.generate(
      { sessionId: 'bs_test', sessionEpoch: 0, requestId: 'r1' } as GenerationRequest,
      new AbortController().signal,
    );
    const result = events[Symbol.asyncIterator]().next();
    await bridge.reset(1);
    const stop = vi.spyOn(bridge.source, 'stop');
    fail(json({ error: { code: 'stale_epoch', message: 'Old request' } }, 409));
    await expect(result).rejects.toMatchObject({ status: 409 });
    expect(bridge.getSnapshot()).toMatchObject({ identity: identity(1), status: 'ready' });
    expect(stop).not.toHaveBeenCalled();
  });
  it('retires the prior session when connecting at a different local epoch', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(caps))
      .mockResolvedValueOnce(json(identity()))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json(identity(4, 'bs_replacement')))
      .mockResolvedValue(json({}));
    const bridge = new BackendSessionBridge({ fetcher });
    cleanups.push(() => bridge.dispose());
    await bridge.ensure(0);
    await bridge.ensure(4);
    expect(fetcher.mock.calls[2]![0]).toContain('/sessions/bs_test?sessionEpoch=0');
    expect(fetcher.mock.calls[2]![1]!.method).toBe('DELETE');
    expect(bridge.getSnapshot().identity?.sessionId).toBe('bs_replacement');
  });
  it.each(['epoch', 'profile'] as const)(
    'waits for obsolete identity deletion before %s replacement at capacity one',
    async (replacement) => {
      let active = false;
      let release!: () => void;
      const deletion = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
        if (String(url).endsWith('/capabilities')) return json(caps);
        if (init?.method === 'DELETE') {
          await deletion;
          active = false;
          return new Response(null, { status: 204 });
        }
        if (init?.method === 'POST') {
          if (active) return json({ error: { code: 'session_limit', message: 'Full' } }, 429);
          active = true;
          const body = JSON.parse(String(init.body)) as { sessionEpoch: number; profile: string };
          return json({
            ...identity(body.sessionEpoch, `bs_${body.profile}_${body.sessionEpoch}`),
            profile: body.profile,
          });
        }
        throw new Error('Unexpected request');
      });
      const bridge = new BackendSessionBridge({ fetcher });
      cleanups.push(() => bridge.dispose());
      await bridge.ensure(0);
      if (replacement === 'profile') bridge.select('profile', 'india');
      const connecting = bridge.ensure(replacement === 'epoch' ? 4 : 0);
      await vi.waitFor(() =>
        expect(fetcher.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(true),
      );
      expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
      release();
      await expect(connecting).resolves.toMatchObject({
        sessionEpoch: replacement === 'epoch' ? 4 : 0,
      });
      expect(bridge.getSnapshot().status).toBe('ready');
    },
  );
  it('stops capture on an expired generation session and waits for explicit reconnect', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(caps))
      .mockResolvedValueOnce(json(identity()))
      .mockResolvedValueOnce(
        json({ error: { code: 'session_expired', message: 'Reconnect' } }, 410),
      )
      .mockResolvedValue(json(identity(0, 'bs_new')));
    const bridge = new BackendSessionBridge({ fetcher });
    cleanups.push(() => bridge.dispose());
    await bridge.ensure(0);
    const stop = vi.spyOn(bridge.source, 'stop');
    const events = bridge.transport.generate(
      { sessionId: 'bs_test', sessionEpoch: 0, requestId: 'r1' } as GenerationRequest,
      new AbortController().signal,
    );
    await expect(events[Symbol.asyncIterator]().next()).rejects.toMatchObject({ status: 410 });
    expect(stop).toHaveBeenCalled();
    expect(bridge.getSnapshot()).toMatchObject({ identity: null, status: 'error' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await bridge.ensure(0)).sessionId).toBe('bs_new');
  });
  it('is lazy, pins an imported local epoch, and recovers from backend restart', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(caps))
      .mockResolvedValueOnce(json(identity(4)))
      .mockResolvedValueOnce(
        json({ error: { code: 'session_expired', message: 'Reconnect' } }, 410),
      )
      .mockResolvedValueOnce(json(identity(4, 'bs_restarted')))
      .mockResolvedValue(json({}));
    const bridge = new BackendSessionBridge({ fetcher });
    cleanups.push(() => bridge.dispose());
    expect(fetcher).not.toHaveBeenCalled();
    expect((await bridge.ensure(4)).sessionEpoch).toBe(4);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body)).sessionEpoch).toBe(4);
    expect((await bridge.ensure(4)).sessionId).toBe('bs_restarted');
    expect(fetcher.mock.calls.map((call) => String(call[0]))).not.toContain(
      expect.stringContaining('/generations'),
    );
  });
  it('honors disabled profile selection and resets the remote epoch', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(caps))
      .mockResolvedValueOnce(json(identity()))
      .mockResolvedValueOnce(json(identity(1)))
      .mockResolvedValue(json({}));
    const bridge = new BackendSessionBridge({ fetcher });
    cleanups.push(() => bridge.dispose());
    await bridge.ensure(0);
    bridge.select('diagramProfile', 'other');
    expect(bridge.getSnapshot().diagramProfile).toBe('mock');
    await bridge.reset(1);
    expect(bridge.getSnapshot().identity?.sessionEpoch).toBe(1);
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]!.body))).toEqual({
      sessionId: 'bs_test',
      sessionEpoch: 0,
    });
  });
  it('ignores a connection superseded by reset and deletes its orphan session', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(caps))
      .mockImplementationOnce(
        () =>
          new Promise((yes) => {
            resolve = yes;
          }),
      )
      .mockResolvedValue(json({}));
    const bridge = new BackendSessionBridge({ fetcher });
    cleanups.push(() => bridge.dispose());
    const connecting = bridge.ensure(0);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await bridge.reset(1);
    resolve(json(identity()));
    await expect(connecting).rejects.toThrow('superseded');
    expect(bridge.getSnapshot().identity).toBeNull();
    expect(fetcher.mock.calls[2]![1]!.method).toBe('DELETE');
  });
  it('continues after failures and reconsiders deferred text only once with new speech', async () => {
    const requests: Record<string, unknown>[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/capabilities')) return json(caps);
      if (String(url).endsWith('/generations')) {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(request);
        const base = {
          wireVersion: 1,
          requestId: request.requestId,
          sessionEpoch: request.sessionEpoch,
        };
        return new Response(
          [
            { ...base, event: 'started', sequence: 1, baseRevision: request.baseRevision },
            {
              ...base,
              event: 'failed',
              sequence: 2,
              code: 'fixture',
              message: 'Interrupted',
              retryable: false,
            },
          ]
            .map((e) => JSON.stringify(e))
            .join('\n'),
          { headers: { 'Content-Type': 'application/x-ndjson' } },
        );
      }
      return json(identity());
    });
    const runtime = createRendererRuntime({ backend: { fetcher } });
    cleanups.push(() => runtime.dispose());
    vi.spyOn(runtime.backend.source, 'start').mockImplementation((_emit, state) =>
      state?.('recording'),
    );
    vi.spyOn(runtime.backend.source, 'stop').mockImplementation(() => {});
    await runtime.session.start('backend');
    runtime.session.ingest({
      id: 'final1',
      text: 'browser to server',
      isFinal: true,
      startMs: 0,
      endMs: 1000,
    });
    runtime.session.sendNow();
    await vi.waitFor(() => expect(runtime.session.getSnapshot().generation).toBe('idle'));
    expect(runtime.session.getSnapshot().canRetry).toBe(false);
    runtime.session.ingest({
      id: 'final2',
      text: 'database',
      isFinal: true,
      startMs: 1000,
      endMs: 2000,
    });
    runtime.session.sendNow();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await vi.waitFor(() => expect(runtime.session.getSnapshot().inFlight).toBe(false));
    expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId);
    expect(requests[1]!.transcript).toMatchObject({ segmentIds: ['final1', 'final2'] });
    runtime.session.ingest({
      id: 'final3',
      text: 'response',
      isFinal: true,
      startMs: 2000,
      endMs: 3000,
    });
    runtime.session.sendNow();
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]!.transcript).toMatchObject({ segmentIds: ['final2', 'final3'] });
  });
  it('hold release flushes final tail text and ignores partials before diagram generation', async () => {
    const requests: GenerationRequest[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/capabilities')) return json(caps);
      if (String(url).endsWith('/generations')) {
        const request = JSON.parse(String(init?.body)) as GenerationRequest;
        requests.push(request);
        const base = {
          wireVersion: 1,
          requestId: request.requestId,
          sessionEpoch: request.sessionEpoch,
        };
        return new Response(
          [
            { ...base, event: 'started', sequence: 1, baseRevision: request.baseRevision },
            { ...base, event: 'completed', sequence: 2, operationCount: 0, warningCount: 0 },
          ]
            .map((e) => JSON.stringify(e))
            .join('\n'),
          { headers: { 'Content-Type': 'application/x-ndjson' } },
        );
      }
      return json(identity());
    });
    const runtime = createRendererRuntime({ backend: { fetcher } });
    cleanups.push(() => runtime.dispose());
    let deliver!: Parameters<typeof runtime.backend.source.start>[0];
    const tail = {
      id: 'hold_tail',
      text: 'client sends a request',
      isFinal: true,
      startMs: 0,
      endMs: 5000,
    };
    vi.spyOn(runtime.backend.source, 'start').mockImplementation((emit, state) => {
      deliver = emit;
      state?.('recording');
    });
    vi.spyOn(runtime.backend.source, 'stop').mockImplementation(() => {});
    const finish = vi.spyOn(runtime.backend.source, 'finish').mockImplementation(async () => {
      deliver(tail);
    });
    await runtime.session.beginHold();
    deliver({ ...tail, isFinal: false, text: 'client sends a history period' });
    expect(runtime.session.getSnapshot().transcript).toHaveLength(0);
    expect(requests).toHaveLength(0);
    await runtime.session.releaseHold();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(finish).toHaveBeenCalledOnce();
    expect(requests[0]!.transcript.text).toBe(tail.text);
    expect(runtime.session.getSnapshot().holdActive).toBe(false);
  });
});
