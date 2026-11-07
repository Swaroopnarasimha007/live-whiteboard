import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generationEventSchema, generationRequestSchema, operationSchema } from './schemas';

// Snapshot exported from backed/shared/protocol/v1; backend export --check verifies drift.
const fixturePath = process.env.WHITEBOARD_PROTOCOL_DIR
  ? resolve(process.env.WHITEBOARD_PROTOCOL_DIR, 'fixtures.json')
  : new URL('../../tests/fixtures/backend-v1.json', import.meta.url);
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<
  string,
  { valid: unknown[]; invalid: unknown[] }
>;

describe('B0 shared Python/TypeScript protocol fixtures', () => {
  for (const [name, schema] of [
    ['operation', operationSchema],
    ['generation-request', generationRequestSchema],
    ['generation-event', generationEventSchema],
  ] as const) {
    it(`agrees on all ${name} examples`, () => {
      for (const value of fixtures[name]!.valid) expect(schema.safeParse(value).success).toBe(true);
      for (const value of fixtures[name]!.invalid)
        expect(schema.safeParse(value).success).toBe(false);
    });
  }
});
