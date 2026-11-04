import { expect, it } from 'vitest';
import { setup } from '../scene/test-helpers';
import { createDocumentController, MAX_DOCUMENT_BYTES } from './documentController';
it('imports only confirmed valid JSON and preserves current drawing on every failure', async () => {
  const { store, addSection } = setup();
  addSection();
  const doc = createDocumentController(store);
  const before = doc.exportText();
  expect(doc.importText('{}', false)).toBe(false);
  expect(doc.importText('{}', true)).toBe(false);
  expect(doc.exportText()).toBe(before);
  expect(doc.importText('x'.repeat(MAX_DOCUMENT_BYTES + 1), true)).toBe(false);
  expect(doc.exportText()).toBe(before);
  store.reset();
  expect(doc.importText(before, true)).toBe(true);
  expect(doc.exportText()).toBe(before);
  await doc.dispose();
  store.dispose();
});
it('skips stale async file reads and enforces byte limits before reading the file', async () => {
  const { store, addSection } = setup();
  const doc = createDocumentController(store);
  let resolve: (text: string) => void = () => {};
  const file = {
    size: 20,
    text: () =>
      new Promise<string>((r) => {
        resolve = r;
      }),
  };
  const pending = doc.importFile(file, true);
  addSection();
  const before = doc.exportText();
  resolve(before);
  expect(await pending).toBe(false);
  expect(doc.getSnapshot().message).toContain('changed');
  expect(
    await doc.importFile(
      {
        size: MAX_DOCUMENT_BYTES + 1,
        text: () => {
          throw new Error('must not read');
        },
      },
      true,
    ),
  ).toBe(false);
  expect(doc.exportText()).toBe(before);
  await doc.dispose();
  store.dispose();
});
it('restores persisted geometry and exposes save failures without stopping drawing', async () => {
  const { store, addSection } = setup();
  let saved: unknown = null;
  let fail = false;
  const doc = createDocumentController(store, {
    read: async () => saved,
    write: async (scene) => {
      if (fail) throw new Error('quota');
      saved = scene;
    },
  });
  addSection();
  expect(await doc.flush()).toBe(true);
  store.reset();
  expect(await doc.restore()).toBe(true);
  expect(Object.keys(store.getSnapshot().sections)).toEqual(['g_s']);
  fail = true;
  expect(await doc.flush()).toBe(false);
  expect(doc.getSnapshot()).toMatchObject({ saveState: 'error' });
  expect(doc.getSnapshot().message).toContain('quota');
  await doc.dispose();
  store.dispose();
});
