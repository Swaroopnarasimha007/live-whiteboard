import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIndexedDbPersistence,
  createSceneAutosave,
  type ScenePersistence,
} from './persistence';
import { setup } from './test-helpers';

afterEach(() => vi.useRealTimers());
function memoryPersistence(): ScenePersistence & { value: unknown } {
  return {
    value: null,
    async read() {
      return structuredClone(this.value);
    },
    async write(scene) {
      this.value = structuredClone(scene);
    },
  };
}

describe('debounced scene autosave', () => {
  it('coalesces committed changes and saves only canonical document data', async () => {
    vi.useFakeTimers();
    const { store, addSection, addNode } = setup();
    const persistence = memoryPersistence();
    const write = vi.spyOn(persistence, 'write');
    const autosave = createSceneAutosave(store, persistence, { debounceMs: 100 });
    addSection();
    addNode();
    expect(autosave.getStatus().state).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(99);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledOnce();
    expect(persistence.value).toEqual(store.getSnapshot());
    expect(autosave.getStatus().state).toBe('saved');
    expect(Object.keys(persistence.value as object).sort()).toEqual([
      'documentId',
      'edges',
      'nodes',
      'revision',
      'schemaVersion',
      'sections',
    ]);
    await autosave.dispose();
  });
  it('surfaces quota failure while drawing continues and supports explicit retry', async () => {
    const { store, addSection, addNode } = setup();
    const persistence = memoryPersistence();
    const write = vi
      .spyOn(persistence, 'write')
      .mockRejectedValueOnce(new Error('QuotaExceededError'));
    const statuses: string[] = [];
    const autosave = createSceneAutosave(store, persistence, {
      onStatus: (s) => statuses.push(s.state),
    });
    addSection();
    expect(await autosave.flush()).toBe(false);
    expect(autosave.getStatus()).toMatchObject({
      state: 'error',
      message: expect.stringContaining('QuotaExceededError'),
    });
    expect(addNode().status).toBe('applied');
    expect(await autosave.flush()).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(persistence.value).toEqual(store.getSnapshot());
    expect(statuses).toContain('error');
    await autosave.dispose();
  });
  it('serializes saves so an older in-flight write cannot overwrite newer work', async () => {
    const { store, addSection, addNode } = setup();
    const persistence = memoryPersistence();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actualWrite = persistence.write.bind(persistence);
    const write = vi.spyOn(persistence, 'write').mockImplementationOnce(async (scene) => {
      await gate;
      await actualWrite(scene);
    });
    const autosave = createSceneAutosave(store, persistence);
    addSection();
    const saving = autosave.flush();
    addNode();
    const newer = autosave.flush();
    release();
    expect(await saving).toBe(true);
    expect(await newer).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(persistence.value).toEqual(store.getSnapshot());
    await autosave.dispose();
  });
  it('restores only validated scenes and preserves current document on corruption', async () => {
    const { store, addSection, addNode } = setup();
    addSection();
    addNode();
    const persistence = memoryPersistence();
    const autosave = createSceneAutosave(store, persistence);
    await autosave.flush();
    const saved = store.getSnapshot();
    store.reset();
    expect(await autosave.restore()).toBe(true);
    expect(store.getSnapshot()).toEqual(saved);
    expect(store.getHistoryState().undoCount).toBe(0);
    persistence.value = { schemaVersion: 999 };
    const before = store.getSnapshot();
    expect(await autosave.restore()).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(autosave.getStatus().state).toBe('error');
    await autosave.dispose();
  });
  it('does not overwrite edits committed while asynchronous restore is loading', async () => {
    const { store, addSection, addNode } = setup();
    addSection();
    const snapshot = store.getSnapshot();
    let release!: (scene: unknown) => void;
    const persistence: ScenePersistence = {
      read: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      write: async () => {},
    };
    const autosave = createSceneAutosave(store, persistence);
    const restoring = autosave.restore();
    addNode();
    release(snapshot);
    expect(await restoring).toBe(false);
    expect(store.getSnapshot().nodes.g_n).toBeDefined();
    expect(autosave.getStatus()).toMatchObject({
      state: 'error',
      message: expect.stringContaining('document changed'),
    });
    await autosave.dispose();
  });
  it('disposal clears timers/listeners and optionally flushes before closing', async () => {
    vi.useFakeTimers();
    const { store, addSection, addNode } = setup();
    const persistence = memoryPersistence();
    const write = vi.spyOn(persistence, 'write');
    const close = vi.fn();
    persistence.close = close;
    const autosave = createSceneAutosave(store, persistence);
    addSection();
    await autosave.dispose({ flush: true });
    addNode();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(autosave.getStatus().state).toBe('disposed');
  });
  it('reports IndexedDB unavailability as a recoverable error', async () => {
    const persistence = createIndexedDbPersistence();
    const { store } = setup();
    const autosave = createSceneAutosave(store, persistence);
    expect(await autosave.flush()).toBe(false);
    expect(autosave.getStatus()).toMatchObject({
      state: 'error',
      message: expect.stringContaining('IndexedDB is unavailable'),
    });
    await autosave.dispose();
  });
});
