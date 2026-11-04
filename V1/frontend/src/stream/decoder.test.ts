import { describe, expect, it } from 'vitest';
import { createNdjsonDecoder, type DecodedRecord } from './decoder';
import { STREAM_LIMITS } from './types';

describe('bounded UTF-8 NDJSON framing', () => {
  it.each([1, 2, 3, 7, 31, 256])(
    'preserves Unicode and escaped newlines across %s-byte fragments',
    (size) => {
      const records: DecodedRecord[] = [];
      const text = '{"label":"café 系统 😀\\nsecond"}\r\n\n{"ok":true}';
      const bytes = new TextEncoder().encode(text);
      const decoder = createNdjsonDecoder({ onRecord: (r) => records.push(r) });
      for (let i = 0; i < bytes.length; i += size) decoder.push(bytes.slice(i, i + size));
      decoder.finish();
      expect(records.map((r) => r.text)).toEqual([
        '{"label":"café 系统 😀\\nsecond"}',
        '',
        '{"ok":true}',
      ]);
      expect(records.every((r) => !r.utf8Error)).toBe(true);
      expect(decoder.getBufferedBytes()).toBe(0);
    },
  );
  it('diagnoses malformed/truncated UTF-8 per record and recovers on the next line', () => {
    const records: DecodedRecord[] = [];
    const decoder = createNdjsonDecoder({ onRecord: (r) => records.push(r) });
    decoder.push(new Uint8Array([0xc3, 10, 0x61, 10]));
    decoder.push(new Uint8Array([0xe7]));
    decoder.finish();
    expect(records.map((r) => r.utf8Error)).toEqual([true, false, true]);
    expect(records[1]!.text).toBe('a');
  });
  it('allows a record of exactly 64 KiB with CRLF and rejects a larger completed line', () => {
    const record = 'x'.repeat(STREAM_LIMITS.lineBytes);
    const output: DecodedRecord[] = [];
    const decoder = createNdjsonDecoder({ onRecord: (r) => output.push(r) });
    decoder.push(new TextEncoder().encode(record + '\r\n'));
    expect(output[0]!.bytes).toBe(STREAM_LIMITS.lineBytes);
    expect(() => decoder.push(new TextEncoder().encode(record + 'x\n'))).toThrow('record exceeds');
  });
  it('bounds the unfinished record buffer at 128 KiB and checks a final line limit', () => {
    const decoder = createNdjsonDecoder({ onRecord: () => {} });
    decoder.push(new Uint8Array(STREAM_LIMITS.partialBytes).fill(32));
    expect(decoder.getBufferedBytes()).toBe(STREAM_LIMITS.partialBytes);
    expect(() => decoder.push(new Uint8Array([32]))).toThrow('Partial NDJSON');
    const final = createNdjsonDecoder({ onRecord: () => {} });
    final.push(new Uint8Array(STREAM_LIMITS.lineBytes + 1).fill(32));
    expect(() => final.finish()).toThrow('record exceeds');
  });
  it('cleans aborted data and rejects writes after termination', () => {
    const decoder = createNdjsonDecoder({ onRecord: () => {} });
    decoder.push(new TextEncoder().encode('partial'));
    decoder.abort();
    expect(decoder.getBufferedBytes()).toBe(0);
    expect(() => decoder.push(new Uint8Array())).toThrow('closed');
  });
});
