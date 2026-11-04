import { z } from 'zod';
import { idSchema } from '../../contracts';

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const audioFormatSchema = z.strictObject({
  encoding: z.literal('pcm_s16le'),
  sampleRateHz: z.literal(16000),
  channels: z.literal(1),
});
const base = { streamId: idSchema, sessionEpoch: counter };
export const audioServerEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...base,
    type: z.literal('ready'),
    profile: idSchema,
    format: audioFormatSchema,
  }),
  z
    .strictObject({
      ...base,
      type: z.literal('transcript'),
      id: idSchema,
      text: z.string(),
      startMs: z.number().finite().nonnegative(),
      endMs: z.number().finite().nonnegative(),
      isFinal: z.boolean(),
    })
    .refine((e) => e.endMs >= e.startMs, 'Invalid transcript interval'),
  z.strictObject({ ...base, type: z.literal('processed'), samples: counter }),
  z.strictObject({
    ...base,
    type: z.literal('progress'),
    stage: z.enum(['transcribing', 'listening']),
  }),
  z.strictObject({ ...base, type: z.literal('error'), code: z.string(), message: z.string() }),
  z.strictObject({
    ...base,
    type: z.literal('closed'),
    reason: z.enum(['finished', 'aborted', 'error']),
  }),
]);
export type AudioServerEvent = z.infer<typeof audioServerEventSchema>;
export interface AudioSessionConfig {
  url: string;
  sessionEpoch: number;
  profile: string;
}
