import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
    await h.startHarness();
    h.runtime.loadFixture();
  });
});

test('manually added and moved Database reaches the next request unchanged and is reused by a generated edge', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
    const section = Object.keys(h.runtime.store.getSnapshot().sections)[0]!;
    const id = `m_${crypto.randomUUID()}`;
    const meta = () => ({
      source: 'manual' as const,
      sessionEpoch: h.runtime.store.getSessionEpoch(),
      transactionId: `manual_${crypto.randomUUID()}`,
    });
    h.runtime.store.dispatch(
      { op: 'node.add', id, section, type: 'rect', label: 'Database', at: [200, 300] },
      meta(),
    );
    h.runtime.store.dispatch({ op: 'node.update', id, set: { at: [713, 219] } }, meta());
    const edge = Object.keys(h.runtime.store.getSnapshot().edges)[0]!;
    h.runtime.store.dispatch({ op: 'entity.lock', id: edge, locked: true }, meta());
    const before = h.runtime.store.getSnapshot().nodes[id];
    const protectedEdge = h.runtime.store.getSnapshot().edges[edge];
    const response = await h.request('The server queries the database', 'manual_database');
    return {
      id,
      before,
      protectedEdge,
      response,
      request: h.lastRequest,
      after: h.runtime.store.getSnapshot().nodes[id],
      edges: Object.values(h.runtime.store.getSnapshot().edges),
    };
  });
  expect(
    result.request.board.nodes.find((node: { id: string }) => node.id === result.id),
  ).toMatchObject({
    id: result.id,
    x: 713,
    y: 219,
    width: result.before.width,
    height: result.before.height,
    source: 'manual',
  });
  expect(result.after).toEqual(result.before);
  expect(
    result.request.board.edges.find((edge: { id: string }) => edge.id === result.protectedEdge.id),
  ).toMatchObject({
    locked: true,
    revision: result.protectedEdge.revision,
    source: result.protectedEdge.source,
  });
  expect((result.edges as { to: string }[]).some((edge) => edge.to === result.id)).toBe(true);
});

test('mid-JSON real HTTP EOF preserves completed objects and reports incomplete generation', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
    const { HttpGenerationTransport } = await import(
      /* @vite-ignore */ '/src/stream/backend/' + 'transport.ts'
    );
    const response = await h.request(
      'browser',
      'truncated',
      new HttpGenerationTransport('http://127.0.0.1:8024/_b4'),
    );
    return {
      response,
      labels: Object.values(h.runtime.store.getSnapshot().nodes).map(
        (node) => (node as { label: string }).label,
      ),
    };
  });
  expect(result.response.phase, JSON.stringify(result.response)).toBe('error');
  expect(
    result.response.diagnostics.some((item: { code: string }) => item.code === 'TRANSPORT'),
  ).toBe(true);
  expect(result.labels).toContain('Retained Browser');
  expect(result.response.stats.applied).toBe(2);
});

test('manual movement and label editing during delayed HTTP generation survive stale model updates; next request has committed geometry', async ({
  page,
}) => {
  const sent: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/generations')) sent.push(request.postDataJSON());
  });
  const pending = page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
    return h.request('B4 stale update', 'stale');
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
        return h.lastRequest?.requestId === 'stale' && h.runtime.stream.consumer.isActive();
      }),
    )
    .toBe(true);
  const edit = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
    return h.manualMoveAndLabel();
  });
  expect(edit.status).toBe('applied');
  const result = await pending;
  expect(result.stats.rejected, JSON.stringify(result)).toBe(1);
  const next = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
    const result = await h.request('The database uses a cache', 'fresh');
    return { result, request: h.lastRequest, scene: h.runtime.store.getSnapshot() };
  });
  expect(next.request.board.nodes[0]).toMatchObject({ x: 413, y: 117, label: 'User edited label' });
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(next.request);
  expect(
    next.request.board.edges.every(
      (edge: { locked: boolean; source: string; revision: number }) =>
        typeof edge.locked === 'boolean' &&
        typeof edge.source === 'string' &&
        Number.isInteger(edge.revision),
    ),
  ).toBe(true);
});

test('replay preserves operation identities; reset rejects late events and never resurrects objects', async ({
  page,
}) => {
  const replay = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
    await h.request('The database uses a cache', 'replay');
    const before = h.runtime.store.exportScene();
    const request = h.lastRequest;
    const events = [];
    for await (const event of h.runtime.backend.transport.replay(
      request,
      0,
      new AbortController().signal,
    ))
      events.push(event);
    const result = await h.runtime.stream.consumer.consume(request, h.runtime.backend.transport, {
      retry: true,
    });
    return { before, after: h.runtime.store.exportScene(), events, result };
  });
  expect(replay.after).toBe(replay.before);
  expect(replay.result.stats.duplicates).toBeGreaterThan(0);
  expect(replay.events.map((e: { sequence: number }) => e.sequence)).toEqual(
    replay.events.map((_: unknown, index: number) => index + 1),
  );
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
    void h.request('new topic browser server database cache queue worker', 'late');
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
        return h.runtime.stream.consumer.isActive();
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
    h.runtime.session.reset({ confirmed: true });
  });
  await page.waitForTimeout(2100);
  expect(
    await page.evaluate(async () => {
      const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
      return {
        nodes: Object.keys(h.runtime.store.getSnapshot().nodes).length,
        captures: h.activeCaptures,
      };
    }),
  ).toEqual({ nodes: 0, captures: 0 });
});

test('expired backend identity reconnects with fresh identity and full surviving browser board; topic change preserves suspended camera', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
    await h.request('The database uses a cache', 'before');
    const previous = h.runtime.backend.getSnapshot().identity!;
    const before = h.runtime.store.exportScene();
    // Delete exercises the same real HTTP 410/reconciliation path as loss of in-memory state.
    await fetch(
      `http://127.0.0.1:8024/api/v1/sessions/${previous.sessionId}?sessionEpoch=${previous.sessionEpoch}`,
      { method: 'DELETE' },
    );
    h.runtime.viewport.panBy({ x: 91, y: 37 });
    const camera = h.runtime.viewport.getSnapshot().viewport;
    const outcome = await h.request('new topic browser server', 'after');
    return {
      before,
      request: h.lastRequest,
      previous,
      identity: h.runtime.backend.getSnapshot().identity,
      camera,
      afterCamera: h.runtime.viewport.getSnapshot().viewport,
      follow: h.runtime.viewport.getSnapshot().followLive,
      outcome,
      sections: (Object.values(h.runtime.store.getSnapshot().sections) as { title: string }[]).map(
        (s) => s.title,
      ),
    };
  });
  expect(result.identity!.sessionId).not.toBe(result.previous.sessionId);
  expect(result.request.board.nodes).toHaveLength(
    Object.keys(JSON.parse(result.before).nodes).length,
  );
  expect(result.follow).toBe(false);
  expect(result.afterCamera).toEqual(result.camera);
  expect(result.sections).toContain('Next topic');
});
