export { speechEventSchema, type SpeechEvent, type SpeechSource, type CaptureState } from './types';
export type { CapturedAudio, TranscriptionAdapter } from './types';
export { MockSpeechSource, demoSpeechFixtures, type SpeechFixture } from './mock';
export { BackendSpeechSource, type BackendSpeechOptions } from './backend';
export {
  MicrophonePreviewSource,
  type MicrophoneSnapshot,
  type PreviewClip,
  type MicrophoneOptions,
  type MediaEnvironment,
} from './microphone';
