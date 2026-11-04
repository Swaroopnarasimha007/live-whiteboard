import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generationEventSchema,
  generationRequestSchema,
  operationSchema,
} from '../../src/contracts';
import { audioServerEventSchema } from '../../src/audio/backend/protocol';

// Read the same file Python validates, rather than a second manually copied corpus.
const fixturePath = process.env.WHITEBOARD_PROTOCOL_DIR
  ? resolve(process.env.WHITEBOARD_PROTOCOL_DIR, 'fixtures.json')
  : new URL('../../../shared/protocol/v1/fixtures.json', import.meta.url);
const exists = existsSync(fixturePath);
if (!exists && process.env.WHITEBOARD_REQUIRE_PROTOCOL === '1')
  throw new Error(
    `B4 canonical protocol corpus is required at ${String(fixturePath)}; set WHITEBOARD_PROTOCOL_DIR`,
  );
const fixtures = exists
  ? (JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<
      string,
      { valid: unknown[]; invalid: unknown[] }
    >)
  : {};
describe.skipIf(!exists)('B4 cross-language shared corpus', () => {
  for (const [name, schema] of [
    ['operation', operationSchema],
    ['generation-request', generationRequestSchema],
    ['generation-event', generationEventSchema],
    ['audio-server-event', audioServerEventSchema],
  ] as const) {
    it(`agrees on ${name}`, () => {
      for (const input of fixtures[name]!.valid) expect(schema.safeParse(input).success).toBe(true);
      for (const input of fixtures[name]!.invalid)
        expect(schema.safeParse(input).success).toBe(false);
    });
  }
});
