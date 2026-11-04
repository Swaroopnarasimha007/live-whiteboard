import { isSafeData, type Scene } from '../contracts';
import type { SceneStore } from './store';
import { freeze } from './utils';

export interface ScenePersistence {
  read(): Promise<unknown | null>;
  write(scene: Scene): Promise<void>;
  close?(): void;
}
export interface IndexedDbOptions {
  databaseName?: string;
  key?: string;
  factory?: IDBFactory;
  openTimeoutMs?: number;
}

/** Stores canonical scenes only, with IndexedDB's transaction completion as the durability boundary. */
export function createIndexedDbPersistence(options: IndexedDbOptions = {}): ScenePersistence {
  const factory = options.factory ?? globalThis.indexedDB;
  const key = options.key ?? 'current';
  let opening: Promise<IDBDatabase> | undefined;
  let database: IDBDatabase | undefined;
  let closed = false;
  const open = () => {
    if (closed) return Promise.reject(new Error('Persistence adapter is closed'));
    if (!factory) return Promise.reject(new Error('IndexedDB is unavailable in this environment'));
    if (!opening) {
      opening = new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(options.databaseName ?? 'live-whiteboard-v1', 1);
        let finished = false;
        const timer = setTimeout(
          () =>
            finish(new Error('IndexedDB open timed out; close other whiteboard tabs and retry')),
          options.openTimeoutMs ?? 5_000,
        );
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (error) {
            opening = undefined;
            reject(error);
          } else {
            database = request.result;
            resolve(database);
          }
        };
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('scenes'))
            request.result.createObjectStore('scenes');
        };
        request.onerror = () => finish(request.error ?? new Error('IndexedDB open failed'));
        request.onblocked = () =>
          finish(new Error('IndexedDB upgrade blocked; close other whiteboard tabs and retry'));
        request.onsuccess = () => {
          if (finished || closed) {
            request.result.close();
            finish(new Error('Persistence adapter is closed'));
            return;
          }
          request.result.onversionchange = () => {
            request.result.close();
            database = undefined;
            opening = undefined;
          };
          finish();
        };
      });
    }
    return opening;
  };
  const transact = async (mode: IDBTransactionMode, value?: Scene): Promise<unknown | null> => {
    const db = await open();
    if (closed) throw new Error('Persistence adapter is closed');
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('scenes', mode);
      const store = transaction.objectStore('scenes');
      const request = mode === 'readonly' ? store.get(key) : store.put(value, key);
      let result: unknown = null;
      request.onsuccess = () => {
        result = request.result ?? null;
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () =>
        reject(transaction.error ?? request.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  };
  return {
    read: () => transact('readonly'),
    write: async (scene) => {
      await transact('readwrite', scene);
    },
    close: () => {
      closed = true;
      database?.close();
      database = undefined;
    },
  };
}

export interface AutosaveStatus {
  state: 'idle' | 'scheduled' | 'saving' | 'saved' | 'restoring' | 'error' | 'disposed';
  message?: string;
}
export function createSceneAutosave(
  store: SceneStore,
  persistence: ScenePersistence,
  options: { debounceMs?: number; onStatus?: (status: AutosaveStatus) => void } = {},
) {
  if (!Number.isFinite(options.debounceMs ?? 300) || (options.debounceMs ?? 300) < 0)
    throw new Error('Invalid autosave debounce duration');
  let status: AutosaveStatus = freeze({ state: 'idle' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty: Scene | undefined;
  let writing: Promise<boolean> | undefined;
  let disposed = false;
  let restoring = false;
  const listeners = new Set<(status: AutosaveStatus) => void>();
  const setStatus = (next: AutosaveStatus) => {
    status = freeze(next);
    for (const listener of [options.onStatus, ...listeners]) {
      try {
        listener?.(status);
      } catch {
        /* Status consumers cannot block persistence. */
      }
    }
  };
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const save = (): Promise<boolean> => {
    clearTimer();
    if (disposed || restoring) return Promise.resolve(false);
    if (writing) return writing;
    writing = (async () => {
      while (dirty && !disposed) {
        const scene = dirty;
        dirty = undefined;
        setStatus({ state: 'saving' });
        try {
          await persistence.write(scene);
        } catch (error) {
          dirty ??= scene;
          setStatus({
            state: 'error',
            message: `Autosave failed: ${error instanceof Error ? error.message : String(error)}. Drawing remains available; retry saving or export the document.`,
          });
          return false;
        }
      }
      if (!disposed) setStatus({ state: 'saved' });
      return true;
    })().finally(() => {
      writing = undefined;
    });
    return writing;
  };
  const unsubscribe = store.subscribe((scene) => {
    if (disposed || restoring) return;
    dirty = scene;
    clearTimer();
    setStatus({ state: 'scheduled' });
    timer = setTimeout(() => {
      void save();
    }, options.debounceMs ?? 300);
  });
  return {
    getStatus: () => status,
    subscribe: (listener: (status: AutosaveStatus) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flush: () => {
      if (!disposed && !restoring) dirty = store.getSnapshot();
      return save();
    },
    restore: async (): Promise<boolean> => {
      if (disposed || restoring) return false;
      restoring = true;
      clearTimer();
      const expectedScene = store.getSnapshot();
      dirty = undefined;
      try {
        if (writing && !(await writing)) throw new Error('An outstanding save failed');
        setStatus({ state: 'restoring' });
        const data = await persistence.read();
        if (disposed) return false;
        if (store.getSnapshot() !== expectedScene)
          throw new Error('The document changed while loading; restore was skipped');
        if (data === null) {
          setStatus({ state: 'idle' });
          return false;
        }
        if (!isSafeData(data)) throw new Error('Unsafe saved document');
        const result = store.importScene(JSON.stringify(data));
        if (result.status !== 'applied')
          throw new Error(
            result.status === 'rejected' ? result.message : 'Restore did not complete',
          );
        setStatus({ state: 'saved' });
        return true;
      } catch (error) {
        if (!disposed)
          setStatus({
            state: 'error',
            message: `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        return false;
      } finally {
        restoring = false;
        if (!disposed && store.getSnapshot() !== expectedScene && status.state === 'error') {
          dirty = store.getSnapshot();
          // Preserve edits; wait for an explicit retry/export after a restore conflict.
        }
      }
    },
    dispose: async ({ flush = false }: { flush?: boolean } = {}) => {
      if (disposed) return;
      unsubscribe();
      clearTimer();
      if (flush) {
        dirty = store.getSnapshot();
        await save();
      }
      disposed = true;
      if (writing) await writing;
      dirty = undefined;
      persistence.close?.();
      setStatus({ state: 'disposed' });
      listeners.clear();
    },
  };
}
