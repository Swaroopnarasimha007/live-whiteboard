import { STREAM_LIMITS, StreamError } from './types';

export interface DecodedRecord {
  line: number;
  bytes: number;
  text: string;
  utf8Error: boolean;
}
export interface DecoderOptions {
  onRecord(record: DecodedRecord): void;
  maxLineBytes?: number;
  maxPartialBytes?: number;
}
/** Incremental byte framing: a large incoming chunk is never decoded/copied as one string. */
export function createNdjsonDecoder(options: DecoderOptions) {
  const maxLine = options.maxLineBytes ?? STREAM_LIMITS.lineBytes;
  const maxPartial = options.maxPartialBytes ?? STREAM_LIMITS.partialBytes;
  if (
    ![maxLine, maxPartial].every((n) => Number.isSafeInteger(n) && n > 0) ||
    maxLine > STREAM_LIMITS.lineBytes ||
    maxPartial > STREAM_LIMITS.partialBytes ||
    maxPartial < maxLine
  )
    throw new Error('Invalid NDJSON byte limits');
  let decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  let lastByte = 0;
  let line = 0;
  let utf8Error = false;
  let closed = false;
  const reset = () => {
    decoder = new TextDecoder('utf-8', { fatal: true });
    text = '';
    bytes = 0;
    lastByte = 0;
    utf8Error = false;
  };
  const append = (part: Uint8Array, completed: boolean) => {
    const nextBytes = bytes + part.byteLength;
    const trailingCR = (part.byteLength ? part[part.byteLength - 1] : lastByte) === 13;
    if (completed && nextBytes - (trailingCR ? 1 : 0) > maxLine)
      throw new StreamError('LINE_LIMIT', `NDJSON record exceeds ${maxLine} bytes`);
    if (nextBytes > maxPartial)
      throw new StreamError('BUFFER_LIMIT', `Partial NDJSON buffer exceeds ${maxPartial} bytes`);
    bytes = nextBytes;
    if (part.byteLength) lastByte = part[part.byteLength - 1]!;
    if (!utf8Error) {
      try {
        text += decoder.decode(part, { stream: true });
      } catch {
        utf8Error = true;
        text = '';
      }
    }
  };
  const emit = () => {
    const recordBytes = bytes - (lastByte === 13 ? 1 : 0);
    if (recordBytes > maxLine)
      throw new StreamError('LINE_LIMIT', `NDJSON record exceeds ${maxLine} bytes`);
    if (!utf8Error) {
      try {
        text += decoder.decode();
      } catch {
        utf8Error = true;
      }
    }
    const record = {
      line: ++line,
      bytes: recordBytes,
      text: text.endsWith('\r') ? text.slice(0, -1) : text,
      utf8Error,
    };
    reset();
    options.onRecord(record);
  };
  return {
    push(chunk: Uint8Array) {
      if (closed) throw new StreamError('DISPOSED', 'Decoder is closed');
      if (!(chunk instanceof Uint8Array))
        throw new StreamError('TRANSPORT', 'Transport must yield Uint8Array chunks');
      let offset = 0;
      while (offset < chunk.byteLength) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.byteLength : newline;
        append(chunk.subarray(offset, end), newline !== -1);
        if (newline !== -1) emit();
        offset = end + (newline === -1 ? 0 : 1);
      }
    },
    finish() {
      if (closed) return;
      closed = true;
      if (bytes) emit();
    },
    abort() {
      closed = true;
      reset();
    },
    getBufferedBytes: () => bytes,
  };
}
