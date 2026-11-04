import { adaptRawFixtureTransport, type RawFixtureTransport } from './rawFixture';
import {
  generationRequestSchema,
  type GenerationRequest,
  type GenerationTransport,
} from '../contracts';
import { buildDemoOperations } from './fixtures';
import { freeze, StreamError } from './types';

export interface MockTransportOptions {
  fixture?: readonly unknown[] | ((request: GenerationRequest) => readonly unknown[]);
  seed?: number;
  minChunkBytes?: number;
  maxChunkBytes?: number;
  burstSize?: number;
  delayMs?: number;
  lineDelayMs?: number;
  tailDelayMs?: number;
  malformedAfterRecord?: number;
  disconnectAfterBytes?: number;
  lineEnding?: '\n' | '\r\n';
  finalNewline?: boolean;
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new StreamError('CANCELLED', 'Mock request cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
/** Deterministic browser-only mock. No HTTP, provider SDK, microphone or audio input. */
export class RawMockFixtureTransport implements RawFixtureTransport {
  private readonly options: MockTransportOptions;
  constructor(options: MockTransportOptions = {}) {
    this.options = { ...options };
    for (const value of [
      options.delayMs ?? 0,
      options.lineDelayMs ?? 80,
      options.tailDelayMs ?? 120,
    ])
      if (!Number.isFinite(value) || value < 0)
        throw new Error('Mock delays must be finite and nonnegative');
    const min = options.minChunkBytes ?? 1;
    const max = options.maxChunkBytes ?? 31;
    if (
      !Number.isSafeInteger(min) ||
      !Number.isSafeInteger(max) ||
      min < 1 ||
      max < min ||
      max > 1_048_576
    )
      throw new Error('Invalid mock fragmentation bounds');
    if (!Number.isSafeInteger(options.burstSize ?? 8) || (options.burstSize ?? 8) < 1)
      throw new Error('Invalid mock burst size');
    for (const value of [options.disconnectAfterBytes, options.malformedAfterRecord])
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new Error('Invalid mock failure offset');
  }
  async *generate(input: GenerationRequest, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const request = freeze(generationRequestSchema.parse(input));
    const options = this.options;
    if (signal.aborted)
      throw signal.reason ?? new StreamError('CANCELLED', 'Mock request cancelled');
    const fixture =
      typeof options.fixture === 'function'
        ? options.fixture(request)
        : (options.fixture ?? buildDemoOperations(request));
    const lines = fixture.map((record) =>
      typeof record === 'string' ? record : JSON.stringify(record),
    );
    if (options.malformedAfterRecord !== undefined)
      lines.splice(options.malformedAfterRecord + 1, 0, '{malformed mock record');
    const newline = options.lineEnding ?? '\n';
    const encoder = new TextEncoder();
    const boundaries: number[] = [];
    let total = 0;
    const encoded = lines.map((line, index) => {
      const bytes = encoder.encode(
        line + (index !== lines.length - 1 || options.finalNewline !== false ? newline : ''),
      );
      total += bytes.byteLength;
      boundaries.push(total);
      return bytes;
    });
    if (total > 4 * 1024 * 1024) throw new StreamError('TRANSPORT', 'Mock fixture exceeds 4 MiB');
    const payload = new Uint8Array(total);
    let offset = 0;
    for (const bytes of encoded) {
      payload.set(bytes, offset);
      offset += bytes.byteLength;
    }
    let seed = (options.seed ?? 47) >>> 0;
    let chunks = 0;
    let boundary = 0;
    offset = 0;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    while (offset < payload.byteLength) {
      if (signal.aborted)
        throw signal.reason ?? new StreamError('CANCELLED', 'Mock request cancelled');
      if (options.disconnectAfterBytes !== undefined && offset >= options.disconnectAfterBytes)
        throw new StreamError('TRANSPORT', `Mock disconnected after ${offset} bytes`);
      const size =
        (options.minChunkBytes ?? 1) +
        Math.floor(random() * ((options.maxChunkBytes ?? 31) - (options.minChunkBytes ?? 1) + 1));
      const end = Math.min(
        payload.byteLength,
        offset + size,
        options.disconnectAfterBytes ?? Infinity,
      );
      yield payload.slice(offset, end);
      offset = end;
      chunks++;
      if (signal.aborted)
        throw signal.reason ?? new StreamError('CANCELLED', 'Mock request cancelled');
      let crossed = false;
      while (boundary < boundaries.length && boundaries[boundary]! <= offset) {
        boundary++;
        crossed = true;
      }
      if (crossed && (options.lineDelayMs ?? 80) > 0)
        await delay(options.lineDelayMs ?? 80, signal);
      if (chunks % (options.burstSize ?? 8) === 0) await delay(options.delayMs ?? 0, signal);
    }
    if (
      options.disconnectAfterBytes !== undefined &&
      options.disconnectAfterBytes <= payload.byteLength
    )
      throw new StreamError('TRANSPORT', `Mock disconnected after ${offset} bytes`);
    if ((options.tailDelayMs ?? 120) > 0) await delay(options.tailDelayMs ?? 120, signal);
  }
}

/** Standalone fixture transport using the same typed boundary as HTTP mode. */
export class MockGenerationTransport implements GenerationTransport {
  private readonly transport: GenerationTransport;
  constructor(options: MockTransportOptions = {}) {
    this.transport = adaptRawFixtureTransport(new RawMockFixtureTransport(options));
  }
  generate(request: GenerationRequest, signal: AbortSignal) {
    return this.transport.generate(request, signal);
  }
}
