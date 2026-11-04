import type { SceneStore, ScenePersistence } from '../scene';
import { createSceneAutosave } from '../scene';
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export function createDocumentController(store: SceneStore, persistence?: ScenePersistence) {
  const autosave = persistence ? createSceneAutosave(store, persistence) : null;
  let message = '';
  let disposed = false;
  const listeners = new Set<() => void>();
  let snapshot = Object.freeze({ saveState: autosave?.getStatus().state ?? 'disabled', message });
  const publish = () => {
    if (disposed) return;
    const status = autosave?.getStatus();
    snapshot = Object.freeze({
      saveState: status?.state ?? 'disabled',
      message:
        status?.state === 'error' ? (status.message ?? message) : message || status?.message || '',
    });
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Observer only. */
      }
    }
  };
  const unsubscribe = autosave?.subscribe(publish);
  const fail = (text: string) => {
    message = text;
    publish();
    return false;
  };
  const importText = (text: string, confirmed: boolean) => {
    if (disposed || !confirmed) return false;
    if (new TextEncoder().encode(text).byteLength > MAX_DOCUMENT_BYTES)
      return fail('Document exceeds the 8 MiB import limit. Current drawing is unchanged.');
    const result = store.importScene(text);
    if (result.status !== 'applied')
      return fail(
        `Import failed: ${result.status === 'rejected' ? result.message : 'Document was not applied'}. Current drawing is unchanged.`,
      );
    message = 'Document imported. Transcript and history were reset.';
    publish();
    return true;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    exportText: () => store.exportScene(),
    importText,
    importFile: async (file: Pick<File, 'size' | 'text'>, confirmed: boolean) => {
      if (disposed || !confirmed) return false;
      if (file.size > MAX_DOCUMENT_BYTES)
        return fail('Document exceeds the 8 MiB import limit. Current drawing is unchanged.');
      const expected = store.getSnapshot();
      try {
        const text = await file.text();
        if (disposed) return false;
        if (store.getSnapshot() !== expected)
          return fail(
            'Drawing changed while reading the file. Import skipped; choose the file again.',
          );
        return importText(text, true);
      } catch {
        return fail('Unable to read this file. Choose a JSON whiteboard document.');
      }
    },
    restore: async () => {
      if (disposed || !autosave) return false;
      message = '';
      const restored = await autosave.restore();
      publish();
      return restored;
    },
    flush: async () => {
      if (disposed || !autosave) return false;
      message = '';
      const saved = await autosave.flush();
      publish();
      return saved;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      listeners.clear();
      await autosave?.dispose();
    },
  };
}
