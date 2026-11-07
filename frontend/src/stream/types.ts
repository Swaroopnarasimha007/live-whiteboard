import type { ErrorCode } from '../contracts';

export const STREAM_LIMITS = Object.freeze({
  lineBytes: 64 * 1024,
  partialBytes: 128 * 1024,
  queue: 2_000,
  frameMs: 8,
  diagnostics: 200,
});
export type StreamCode =
  | 'UTF8'
  | 'JSON'
  | 'SCHEMA'
  | 'MARKDOWN'
  | 'LINE_LIMIT'
  | 'BUFFER_LIMIT'
  | 'QUEUE_LIMIT'
  | 'TRANSPORT'
  | 'CANCELLED'
  | 'STALE_CONTEXT'
  | 'INTERACTION_ACTIVE'
  | 'BUSY'
  | 'SCHEDULER'
  | ErrorCode;
export interface StreamDiagnostic {
  code: StreamCode;
  message: string;
  line?: number;
  sequence?: number;
}
export interface StreamStats {
  bytes: number;
  records: number;
  valid: number;
  invalid: number;
  applied: number;
  duplicates: number;
  rejected: number;
  pending: number;
  discarded: number;
  queued: number;
  frames: number;
  firstAppliedMs: number | null;
  elapsedMs: number;
}
export type StreamPhase =
  | 'idle'
  | 'receiving'
  | 'draining'
  | 'completed'
  | 'incomplete'
  | 'cancelled'
  | 'error'
  | 'disposed';
export interface StreamSnapshot {
  phase: StreamPhase;
  requestId: string | null;
  stats: Readonly<StreamStats>;
  diagnostics: readonly StreamDiagnostic[];
}
export interface StreamResult extends StreamSnapshot {
  phase: 'completed' | 'incomplete' | 'cancelled' | 'error';
}
export class StreamError extends Error {
  readonly code: StreamCode;
  constructor(code: StreamCode, message: string) {
    super(message);
    this.name = 'StreamError';
    this.code = code;
  }
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
