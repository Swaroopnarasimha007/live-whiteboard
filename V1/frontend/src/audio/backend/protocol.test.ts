import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { audioServerEventSchema } from './protocol';

describe('shared audio server event fixtures', () => {
  it('matches the frozen backend wire schema', () => {
    const fixtures = JSON.parse(
      readFileSync(new URL('../../../tests/fixtures/backend-v1.json', import.meta.url), 'utf8'),
    ) as Record<string, { valid: unknown[]; invalid: unknown[] }>;
    for (const event of fixtures['audio-server-event']!.valid)
      expect(audioServerEventSchema.safeParse(event).success).toBe(true);
    for (const event of fixtures['audio-server-event']!.invalid)
      expect(audioServerEventSchema.safeParse(event).success).toBe(false);
  });
});
