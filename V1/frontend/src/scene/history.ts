import type { Scene } from '../contracts';
import { equal } from './utils';

type Collection = 'nodes' | 'edges' | 'sections';
export interface FieldPatch {
  collection: Collection;
  id: string;
  field: string | null;
  before: unknown;
  after: unknown;
}
export interface HistoryEntry {
  patches: FieldPatch[];
  expected: Map<string, number>;
  prior: Map<string, number>;
  transactionId: string;
}
const collections = ['sections', 'nodes', 'edges'] as const;
const lifeKey = (patch: FieldPatch) => `${patch.collection}/${patch.id}/@life`;
const fieldKey = (patch: FieldPatch) =>
  `${patch.collection}/${patch.id}/${patch.field ?? '@entity'}`;
const records = (scene: Scene, collection: Collection) =>
  scene[collection] as unknown as Record<string, Record<string, unknown>>;

export function updateFieldVersions(
  previous: Scene,
  next: Scene,
  versions: Map<string, number>,
): void {
  for (const collection of collections) {
    const a = records(previous, collection);
    const b = records(next, collection);
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (equal(a[id], b[id])) continue;
      versions.set(`${collection}/${id}/@entity`, next.revision);
      if (!a[id] || !b[id]) versions.set(`${collection}/${id}/@life`, next.revision);
      for (const field of new Set([...Object.keys(a[id] ?? {}), ...Object.keys(b[id] ?? {})])) {
        if (!equal(a[id]?.[field], b[id]?.[field]))
          versions.set(`${collection}/${id}/${field}`, next.revision);
      }
    }
  }
}

export function captureHistory(
  previous: Scene,
  next: Scene,
  versions: Map<string, number>,
  transactionId: string,
): HistoryEntry {
  const patches: FieldPatch[] = [];
  for (const collection of collections) {
    const a = records(previous, collection);
    const b = records(next, collection);
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const before = a[id];
      const after = b[id];
      if (equal(before, after)) continue;
      if (!before || !after) {
        patches.push({ collection, id, field: null, before, after });
        continue;
      }
      for (const field of Object.keys(after)) {
        if (['revision', 'lastManualRevision'].includes(field)) continue;
        if (collection === 'sections' && ['origin', 'bounds'].includes(field)) continue;
        if (
          collection === 'nodes' &&
          after.sizing === 'auto' &&
          before.sizing === 'auto' &&
          ['width', 'height'].includes(field)
        )
          continue;
        if (!equal(before[field], after[field]))
          patches.push({ collection, id, field, before: before[field], after: after[field] });
      }
    }
  }
  const guarded = guardHistory(
    { patches, expected: new Map(), prior: new Map(), transactionId },
    versions,
  );
  return { ...guarded, prior: historyPriorVersions(guarded, versions) };
}

export function historyPriorVersions(
  entry: HistoryEntry,
  versions: Map<string, number>,
): Map<string, number> {
  const prior = guardHistory(entry, versions).expected;
  for (const patch of entry.patches) {
    const key = `${patch.collection}/${patch.id}/@entity`;
    prior.set(key, versions.get(key) ?? 0);
    if (patch.field === null) {
      for (const field of Object.keys((patch.before ?? patch.after ?? {}) as object)) {
        const fieldStamp = `${patch.collection}/${patch.id}/${field}`;
        prior.set(fieldStamp, versions.get(fieldStamp) ?? 0);
      }
    }
  }
  return prior;
}

export function guardHistory(entry: HistoryEntry, versions: Map<string, number>): HistoryEntry {
  const expected = new Map<string, number>();
  for (const patch of entry.patches) {
    for (const key of [lifeKey(patch), fieldKey(patch)]) expected.set(key, versions.get(key) ?? 0);
  }
  return { ...entry, expected };
}

/** Checks field revisions, including edits that changed a value and then changed it back. */
export function historyMatches(
  entry: HistoryEntry,
  scene: Scene,
  versions: Map<string, number>,
  direction: 'undo' | 'redo',
): boolean {
  for (const [key, expected] of entry.expected)
    if ((versions.get(key) ?? 0) !== expected) return false;
  return entry.patches.every((patch) => {
    const entity = records(scene, patch.collection)[patch.id];
    const actual = patch.field === null ? entity : entity?.[patch.field];
    return equal(actual, direction === 'undo' ? patch.after : patch.before);
  });
}

export function applyHistoryPatches(
  entry: HistoryEntry,
  previous: Scene,
  direction: 'undo' | 'redo',
): Scene {
  const scene = structuredClone(previous);
  for (const patch of entry.patches) {
    const collection = records(scene, patch.collection);
    const value = structuredClone(direction === 'undo' ? patch.before : patch.after);
    if (patch.field === null) {
      if (value === undefined) delete collection[patch.id];
      else collection[patch.id] = value as Record<string, unknown>;
    } else collection[patch.id]![patch.field] = value;
  }
  return scene;
}

/** Rebase only stamps restored by our own inverse, never stamps changed by generation. */
export function rebaseHistory(
  stack: HistoryEntry[],
  inverse: HistoryEntry,
  scene: Scene,
  versions: Map<string, number>,
  direction: 'undo' | 'redo',
): void {
  for (const entry of stack) {
    for (const [key, expected] of entry.expected) {
      if (inverse.prior.get(key) !== expected) continue;
      entry.expected.set(key, versions.get(key) ?? 0);
      // Entity metadata is monotonic even when the semantic entity was restored by undo.
      for (const patch of entry.patches) {
        if (patch.field !== null || fieldKey(patch) !== key) continue;
        const actual = records(scene, patch.collection)[patch.id];
        const expectedEntity = (direction === 'undo' ? patch.after : patch.before) as
          Record<string, unknown> | undefined;
        if (!actual || !expectedEntity) continue;
        const semantic = (entity: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries(entity).filter(
              ([field]) => !['revision', 'lastManualRevision'].includes(field),
            ),
          );
        if (equal(semantic(actual), semantic(expectedEntity))) {
          if (direction === 'undo') patch.after = actual;
          else patch.before = actual;
        }
      }
    }
  }
}
