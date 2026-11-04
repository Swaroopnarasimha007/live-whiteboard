import type { SessionSnapshot } from '../session';
import type { StreamSnapshot } from '../stream';
export function captureLabel(state: SessionSnapshot) {
  if (state.mode === 'backend') {
    if (state.transcribingAudio)
      return state.holdActive
        ? 'Listening · transcribing earlier audio'
        : 'Transcribing remaining audio';
    if (state.capture === 'requesting') return 'Connecting audio';
    if (state.capture === 'error') return 'Backend audio needs attention';
    if (state.capture === 'finishing') return 'Finishing transcription';
    if (state.capture === 'recording') return 'Listening · finalized chunks update the drawing';
    if (state.capture === 'paused') return 'Backend audio paused';
    return 'Hold to talk when ready';
  }
  if (state.capture === 'requesting') return 'Waiting for microphone';
  if (state.capture === 'error') return 'Microphone needs attention';
  if (state.capture === 'paused')
    return state.mode === 'mock' ? 'Mock input paused' : 'Recording paused';
  if (state.capture === 'recording')
    return state.mode === 'mock' ? 'Mock transcript running' : 'Local recording';
  return state.mode === 'mock' ? 'Mock demo ready' : 'Recording stopped';
}
export function generationLabel(state: SessionSnapshot, stream: StreamSnapshot) {
  if (state.generation === 'error') return 'Diagram needs attention';
  if (state.generation === 'paused') return 'Generation paused';
  if (stream.phase === 'receiving') return 'Receiving stream';
  if (stream.phase === 'draining') return 'Applying diagram';
  if (state.generation === 'queued') return `Queued (${state.queued.length})`;
  return 'Ready';
}
