import type { GenerationEvent, GenerationRequest, GenerationTransport } from '../contracts';
import { operationSchema } from '../contracts';
import { createNdjsonDecoder, type DecoderOptions } from './decoder';
import { namespaceOperation } from './namespace';

/** Only model fixtures use bytes. Application transports always yield GenerationEvent. */
export interface RawFixtureTransport {
  generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

export function adaptRawFixtureTransport(
  raw: RawFixtureTransport,
  limits: Pick<DecoderOptions, 'maxLineBytes' | 'maxPartialBytes'> = {},
): GenerationTransport {
  return {
    async *generate(request, signal) {
      let sequence = 0;
      let operations = 0;
      let warnings = 0;
      const queue: GenerationEvent[] = [];
      const base = () => ({
        wireVersion: 1 as const,
        requestId: request.requestId,
        sessionEpoch: request.sessionEpoch,
        sequence: ++sequence,
      });
      const decoder = createNdjsonDecoder({
        ...limits,
        onRecord(record) {
          if (!record.utf8Error && !record.text.trim()) return;
          let code = 'SCHEMA';
          try {
            if (record.utf8Error) {
              code = 'UTF8';
              throw new Error('Invalid UTF-8 record');
            }
            if (record.text.trim().startsWith('```')) {
              code = 'MARKDOWN';
              throw new Error('Markdown fences are not operations');
            }
            let json: unknown;
            try {
              json = JSON.parse(record.text);
            } catch {
              code = 'JSON';
              throw new Error('Malformed JSON record');
            }
            const operation = namespaceOperation(operationSchema.parse(json), request);
            operations++;
            queue.push({
              ...base(),
              event: 'operation',
              baseRevision: request.baseRevision,
              operation,
            });
          } catch (error) {
            warnings++;
            queue.push({
              ...base(),
              event: 'warning',
              code,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });
      yield { ...base(), event: 'started', baseRevision: request.baseRevision };
      try {
        for await (const chunk of raw.generate(request, signal)) {
          try {
            decoder.push(chunk);
          } catch (error) {
            // A later oversized record cannot erase valid earlier records in this chunk.
            while (queue.length) yield queue.shift()!;
            throw error;
          }
          while (queue.length) yield queue.shift()!;
        }
        decoder.finish();
        while (queue.length) yield queue.shift()!;
        yield { ...base(), event: 'completed', operationCount: operations, warningCount: warnings };
      } finally {
        decoder.abort();
      }
    },
  };
}
