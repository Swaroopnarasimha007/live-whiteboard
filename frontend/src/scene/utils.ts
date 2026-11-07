import type { ApplyResult, ErrorCode, Scene } from '../contracts';

export class SceneError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
export function reject(code: ErrorCode, message: string): ApplyResult {
  return { status: 'rejected', code, message };
}
export function failure(error: unknown, fallback: ErrorCode = 'VALIDATION'): ApplyResult {
  return error instanceof SceneError
    ? reject(error.code, error.message)
    : reject(fallback, error instanceof Error ? error.message : String(error));
}
export function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => equal(value, b[index]))
    );
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function emptyScene(documentId: string): Scene {
  return { schemaVersion: 1, documentId, revision: 0, sections: {}, nodes: {}, edges: {} };
}
/** Reuse references of records untouched by a transaction after schema validation. */
export function shareScene(previous: Scene, next: Scene): Scene {
  for (const key of ['sections', 'nodes', 'edges'] as const) {
    const target = next[key] as Record<string, unknown>;
    const original = previous[key] as Record<string, unknown>;
    for (const id of Object.keys(target))
      if (equal(original[id], target[id])) target[id] = original[id];
    if (equal(original, target)) Object.assign(next, { [key]: previous[key] });
  }
  return freeze(next);
}
