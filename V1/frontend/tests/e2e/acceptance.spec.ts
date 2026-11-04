import { expect, test, type Page } from '@playwright/test';
import type { Scene } from '../../src/contracts';
async function start(page: Page, options = {}) {
  await page.goto('/tests/harness.html');
  await page.evaluate(async (options) => {
    await (await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts')).start(options);
  }, options);
  await expect(page.getByRole('application')).toBeVisible();
}
const scene = (page: Page): Promise<Scene> =>
  page.evaluate(async () =>
    (
      await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts')
    ).active.store.getSnapshot(),
  );
async function submit(page: Page, ids?: string[]) {
  await page.evaluate(async (ids) => {
    (await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts')).submit(ids);
  }, ids);
}
const done = (page: Page) =>
  expect(page.getByTestId('generation-state')).toHaveAttribute('data-state', 'idle');
const externalRequests = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const external: string[] = [];
  externalRequests.set(page, external);
  await page.route('**/*', async (route) => {
    if (!new URL(route.request().url()).hostname.match(/^(127\.0\.0\.1|localhost)$/)) {
      external.push(route.request().url());
      await route.abort();
    } else await route.continue();
  });
});
test.afterEach(async ({ page }) => {
  expect(externalRequests.get(page)).toEqual([]);
});

test('01 demo draws Browser, Server and Request before transport completion', async ({ page }) => {
  const speech = ['demo-browser', 'demo-server', 'demo-edge'].map((id, index) => ({
    atMs: index * 20,
    event: { id, text: id, startMs: index * 100, endMs: index * 100 + 100, isFinal: true },
  }));
  await start(page, { speech, mock: { lineDelayMs: 120, tailDelayMs: 1000 } });
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect.poll(async () => Object.keys((await scene(page)).edges).length).toBe(1);
  await expect(page.getByRole('application')).toHaveAttribute('data-last-drawn-revision', '4');
  expect(
    await page.evaluate(
      async () =>
        (await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts')).transportEnded,
    ),
  ).toBe(false);
  const counts = await page.evaluate(async () =>
    (await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts')).commits.map(
      (c: { scene: Scene }) => [
        Object.keys(c.scene.nodes).length,
        Object.keys(c.scene.edges).length,
      ],
    ),
  );
  expect(counts).toEqual([
    [0, 0],
    [1, 0],
    [2, 0],
    [2, 1],
  ]);
  await done(page);
});
test('02 paused manual Database move/resize is sent exactly and reused as an edge endpoint', async ({
  page,
}) => {
  await start(page);
  await submit(page);
  await done(page);
  const manual = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    const r = h.active;
    r.session.pause();
    const b = r.viewport.getVisibleWorldBounds();
    r.editor.insert('ellipse', { x: b.x + b.width / 2, y: b.y + b.height / 2 });
    const id = r.editor.getSnapshot().selectedIds[0]!;
    r.editor.editLabel(id);
    r.editor.setLabelDraft('Database');
    r.editor.commitLabel();
    r.editor.beginResize(id);
    r.editor.previewResize({ [id]: { x: 420, y: 310, width: 240, height: 120 } });
    r.editor.commitGesture();
    await r.session.resume();
    r.session.ingest({
      id: 'demo-database',
      text: 'Query the database',
      startMs: 400,
      endMs: 1000,
      isFinal: true,
    });
    r.session.sendNow();
    return id;
  });
  await done(page);
  const snapshot = await scene(page);
  expect(snapshot.nodes[manual]).toMatchObject({
    x: 420,
    y: 310,
    width: 240,
    height: 120,
    label: 'Database',
    source: 'manual',
  });
  expect(Object.values(snapshot.edges).some((e) => e.to === manual)).toBe(true);
  const context = await page.evaluate(
    async () =>
      (await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts')).requests.at(-1)?.board,
  );
  expect(context.nodes.find((n: { id: string }) => n.id === manual)).toMatchObject({
    x: 420,
    y: 310,
    width: 240,
    height: 120,
  });
});
test('03 stale streamed label cannot overwrite a manual edit', async ({ page }) => {
  await start(page, { staleLabel: true });
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    h.active.loadFixture();
    h.submit(['demo-correction']);
  });
  // The raw fixture installs its release gate after the typed adapter yields
  // started. Wait for its captured request before creating the conflicting edit.
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts')).requests.length,
      ),
    )
    .toBe(1);
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    const id = Object.keys(h.active.store.getSnapshot().nodes)[0]!;
    h.active.editor.editLabel(id);
    h.active.editor.setLabelDraft('Manual label wins');
    h.active.editor.commitLabel();
    h.release();
  });
  await expect(page.getByTestId('generation-state')).toHaveAttribute('data-state', 'error');
  const result = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    return {
      node: Object.values((h.active.store.getSnapshot() as Scene).nodes)[0],
      result: h.active.session.getSnapshot().lastResult,
    };
  });
  expect(result.node!.label).toBe('Manual label wins');
  expect(result.result.stats.rejected).toBe(1);
});
test('04 topic following pauses on navigation and only resumes explicitly', async ({ page }) => {
  await start(page);
  await submit(page);
  await done(page);
  await submit(page, ['demo-topic']);
  await done(page);
  const camera = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    h.active.viewport.panBy({ x: -180, y: 130 }, { manual: true });
    return {
      viewport: h.active.viewport.getSnapshot().viewport,
      origins: Object.fromEntries(
        Object.values((h.active.store.getSnapshot() as Scene).sections).map((s) => [
          s.id,
          s.origin,
        ]),
      ),
    };
  });
  await submit(page, ['demo-browser__later', 'demo-server__later', 'demo-edge__later']);
  await done(page);
  const after = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    const c = h.active.viewport.getSnapshot();
    return {
      viewport: c.viewport,
      anchor: c.anchorSectionId,
      origins: Object.fromEntries(
        Object.values((h.active.store.getSnapshot() as Scene).sections).map((s) => [
          s.id,
          s.origin,
        ]),
      ),
    };
  });
  expect(after.viewport.x).toBe(camera.viewport.x);
  expect(after.viewport.scale).toBe(camera.viewport.scale);
  const dy = after.anchor
    ? (after.origins[after.anchor]?.y ?? 0) - (camera.origins[after.anchor]?.y ?? 0)
    : 0;
  expect(after.viewport.y).toBeCloseTo(camera.viewport.y - dy * camera.viewport.scale, 1);
  await page.getByRole('button', { name: 'Resume live', exact: true }).click();
  await expect(page.getByRole('application')).toHaveAttribute('data-follow-live', 'true');
});
for (const scale of [0.5, 2])
  test(`05 shape insertion under pointer at ${scale * 100}% after pan`, async ({ page }) => {
    await start(page);
    await page.evaluate(async (scale) => {
      const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
      h.active.viewport.zoomAt({ x: 0, y: 0 }, scale);
      h.active.viewport.panBy({ x: -180, y: 120 }, { manual: true });
    }, scale);
    await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
    const box = (await page.getByRole('application').boundingBox())!;
    await page.mouse.click(box.x + 160, box.y + 180);
    const snapshot = await scene(page);
    const node = Object.values(snapshot.nodes)[0]!;
    const s = snapshot.sections[node.sectionId]!;
    expect((node.x + s.origin.x) * scale - 180).toBeCloseTo(160, 0);
    expect((node.y + s.origin.y) * scale + 120).toBeCloseTo(180, 0);
  });
test('06 grid toggles preserve canonical geometry and revision', async ({ page }) => {
  await start(page);
  await submit(page);
  await done(page);
  const before = await scene(page);
  for (let i = 0; i < 6; i++)
    await page.getByRole('checkbox', { name: 'Grid', exact: true }).click();
  expect(await scene(page)).toEqual(before);
});
test('07 all-shape branching fixture resolves dependencies, Unicode, correction and duplicate replay', async ({
  page,
}) => {
  await start(page);
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    const f = await import(/* @vite-ignore */ '/tests/fixtures/' + 'protocol.ts');
    const { MockGenerationTransport } = await import(
      /* @vite-ignore */ '/src/stream/' + 'index.ts'
    );
    const { buildGenerationRequest } = await import(
      /* @vite-ignore */ '/src/context/' + 'index.ts'
    );
    const { currentContextView } = await import(
      /* @vite-ignore */ '/src/app/' + 'streamPreview.ts'
    );
    const request = buildGenerationRequest({
      ...currentContextView(h.active.store, h.active.viewport, h.active.editor),
      scene: h.active.store.getSnapshot(),
      sessionEpoch: 0,
      sessionId: 's_fixture',
      requestId: 'fixture',
      transcript: { segmentIds: ['fixture'], text: 'All shapes', startMs: 0, endMs: 1000 },
    });
    await h.active.stream.consumer.consume(
      request,
      new MockGenerationTransport({
        fixture: f.protocolFixture,
        minChunkBytes: 1,
        maxChunkBytes: 3,
        lineEnding: '\r\n',
        finalNewline: false,
        lineDelayMs: 0,
        tailDelayMs: 0,
      }),
    );
  });
  const s = await scene(page);
  expect(new Set(Object.values(s.nodes).map((n) => n.type)).size).toBe(6);
  expect(s.nodes.g_fixture_server?.label).toBe('API server');
  expect(s.nodes.g_fixture_note?.label).toContain('café 系统 🌍');
  expect(Object.keys(s.nodes)).toHaveLength(7);
  expect(Object.keys(s.edges)).toHaveLength(3);
});
test('08 reset ignores late chunks from a transport that ignores abort', async ({ page }) => {
  await start(page, { late: true });
  await submit(page);
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    h.active.session.reset({ confirmed: true });
    h.release();
  });
  await page.waitForTimeout(100);
  expect(Object.keys((await scene(page)).sections)).toHaveLength(0);
});
test('09 denied microphone leaves mock mode and manual editing available', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Denied', 'NotAllowedError');
    };
  });
  await page.getByRole('combobox', { name: 'Input mode' }).selectOption('microphone');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByTestId('capture-state')).toHaveAttribute('data-state', 'error');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).focus();
  await page.keyboard.press('Enter');
  expect(Object.keys((await scene(page)).nodes)).toHaveLength(1);
  await page.getByRole('combobox', { name: 'Input mode' }).selectOption('mock');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await submit(page);
  await done(page);
});
test('10 delete/undo preserves edges and unrelated newer generated work', async ({ page }) => {
  await start(page);
  await submit(page);
  await done(page);
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    const id = Object.keys(h.active.store.getSnapshot().nodes)[0]!;
    h.active.editor.select(id);
    h.active.editor.deleteSelection();
    h.active.editor.undo();
  });
  await submit(page, ['demo-topic']);
  await done(page);
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    h.active.editor.redo();
    h.active.editor.undo();
  });
  const s = await scene(page);
  expect(Object.keys(s.sections)).toHaveLength(2);
  expect(Object.keys(s.edges)).toHaveLength(1);
  expect(Object.keys(s.nodes)).toHaveLength(2);
});
test('11 exported file imports with identical canonical geometry and identifiers', async ({
  page,
}) => {
  await start(page);
  await submit(page);
  await done(page);
  const before = await scene(page);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export document' }).click();
  const download = await downloading;
  const path = await download.path();
  expect(path).toBeTruthy();
  await page.evaluate(async () => {
    (await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts')).active.session.reset({
      confirmed: true,
    });
  });
  page.once('dialog', (d) => d.accept());
  await page.getByLabel('Import whiteboard JSON').setInputFiles(path!);
  await expect.poll(async () => Object.keys((await scene(page)).nodes).length).toBe(2);
  expect(await scene(page)).toEqual(before);
});
test('12 upstream growth preserves downstream camera anchor and nonoverlapping sections', async ({
  page,
}) => {
  await start(page);
  await submit(page);
  await done(page);
  await submit(page, ['demo-topic']);
  await done(page);
  const result = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    const r = h.active;
    const sections = Object.values((r.store.getSnapshot() as Scene).sections).sort(
      (a, b) => a.order - b.order,
    );
    r.viewport.fitSection(sections[1]!.id);
    const before = r.viewport.getSnapshot().viewport;
    const old = sections[1]!.origin.y;
    r.growFirstSection();
    const after = r.viewport.getSnapshot().viewport;
    const updated = Object.values((r.store.getSnapshot() as Scene).sections).sort(
      (a, b) => a.order - b.order,
    );
    return {
      delta: updated[1]!.origin.y - old,
      cameraDelta: after.y - before.y,
      scale: before.scale,
      gap:
        updated[1]!.origin.y +
        updated[1]!.bounds.y -
        (updated[0]!.origin.y + updated[0]!.bounds.y + updated[0]!.bounds.height),
    };
  });
  expect(result.gap).toBeGreaterThanOrEqual(160);
  expect(result.cameraDelta).toBeCloseTo(-result.delta * result.scale, 1);
});
