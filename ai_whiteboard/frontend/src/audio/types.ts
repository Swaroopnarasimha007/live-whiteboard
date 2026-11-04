import { z } from 'zod';
import { idSchema } from '../contracts';
export const speechEventSchema = z
  .strictObject({
    id: idSchema,
    text: z.string().min(1).max(10000),
    startMs: z.number().finite().nonnegative(),
    endMs: z.number().finite().nonnegative(),
    isFinal: z.boolean(),
  })
  .refine((e) => e.endMs >= e.startMs, 'Invalid speech interval');
export type SpeechEvent = z.infer<typeof speechEventSchema>;
export type CaptureState = 'idle' | 'requesting' | 'recording' | 'finishing' | 'paused' | 'error';
/** Future backend boundary only. These bytes never enter GenerationRequest or scene JSON. */
export interface CapturedAudio {
  blob: Blob;
  mimeType: string;
  startMs: number;
  endMs: number;
}
export interface TranscriptionAdapter {
  transcribe(audio: CapturedAudio, signal: AbortSignal): AsyncIterable<SpeechEvent>;
}
export interface SpeechSource {
  /** False means backpressure: retain this event and retry only after resume. */
  start(onEvent: (event: SpeechEvent) => boolean, onState?: (state: CaptureState) => void): void;
  pause(): void;
  resume(): void;
  stop(): void;
  dispose(): void;
  reset?(): void;
}
