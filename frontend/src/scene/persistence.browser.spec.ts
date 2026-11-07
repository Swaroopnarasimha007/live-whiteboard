import { expect, test } from '@playwright/test';

test('canonical scene round-trips through real IndexedDB with schema validation', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    // Vite serves TypeScript modules for browser-side contract integration.
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { createIndexedDbPersistence, createSceneAutosave } = (await load(
      '/src/scene/persistence.ts',
    )) as typeof import('./persistence');
    const { createSceneStore } = (await load('/src/scene/store.ts')) as typeof import('./store');
    const { testLayout } = (await load(
      '/src/scene/test-helpers.ts',
    )) as typeof import('./test-helpers');
    const persistence = createIndexedDbPersistence({
      databaseName: `agent1-test-${crypto.randomUUID()}`,
    });
    const store = createSceneStore({ documentId: 'browser-test', layout: testLayout });
    const autosave = createSceneAutosave(store, persistence);
    const applied = store.dispatch(
      { op: 'section.add', id: 'g_s', title: 'Saved section' },
      {
        source: 'generated',
        requestId: 'r1',
        sequence: 1,
        baseRevision: 0,
        sessionEpoch: 0,
        transactionId: 'tx1',
      },
    );
    const saved = await autosave.flush();
    const exported = store.exportScene();
    store.reset();
    const restored = await autosave.restore();
    const matches = store.exportScene() === exported;
    await persistence.write({ schemaVersion: 999 } as never);
    const beforeBadRestore = store.getSnapshot();
    const corruptRestore = await autosave.restore();
    const preserved = store.getSnapshot() === beforeBadRestore;
    const status = autosave.getStatus().state;
    await autosave.dispose();
    store.dispose();
    return { applied: applied.status, saved, restored, matches, corruptRestore, preserved, status };
  });
  expect(result).toEqual({
    applied: 'applied',
    saved: true,
    restored: true,
    matches: true,
    corruptRestore: false,
    preserved: true,
    status: 'error',
  });
});
