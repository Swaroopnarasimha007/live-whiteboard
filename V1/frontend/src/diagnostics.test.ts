import { afterEach, expect, it, vi } from 'vitest';
import { diagnostic } from './diagnostics';

afterEach(() => vi.restoreAllMocks());
it('emits one copyable structured console line with explicit metadata only', () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => {});
  diagnostic('consumer.end', { requestId: 'r1', phase: 'incomplete', rejected: 1 });
  expect(output).toHaveBeenCalledTimes(1);
  const line = String(output.mock.calls[0]![0]);
  expect(line.startsWith('[whiteboard.frontend] ')).toBe(true);
  expect(JSON.parse(line.slice('[whiteboard.frontend] '.length))).toMatchObject({
    event: 'consumer.end',
    requestId: 'r1',
    phase: 'incomplete',
    rejected: 1,
  });
});
it('does not interrupt app behavior when console instrumentation fails', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {
    throw new Error('console unavailable');
  });
  expect(() =>
    diagnostic('consumer.operation_rejected', { code: 'STALE_MANUAL_EDIT' }, true),
  ).not.toThrow();
});
