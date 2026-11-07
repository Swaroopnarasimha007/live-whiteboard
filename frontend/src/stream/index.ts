export {
  createStreamConsumer,
  type StreamConsumer,
  type StreamConsumerOptions,
  type ConsumeOptions,
} from './consumer';
export { createNdjsonDecoder, type DecoderOptions, type DecodedRecord } from './decoder';
export {
  createFrameScheduler,
  defaultFrameClock,
  type FrameClock,
  type FrameSchedulerOptions,
} from './scheduler';
export { MockGenerationTransport, type MockTransportOptions } from './mock';
export { buildDemoOperations, DEMO_SEGMENTS } from './fixtures';
export { namespaceOperation } from './namespace';
export {
  STREAM_LIMITS,
  StreamError,
  type StreamCode,
  type StreamDiagnostic,
  type StreamPhase,
  type StreamResult,
  type StreamSnapshot,
  type StreamStats,
} from './types';
export type { GenerationTransport } from '../contracts';
