import { isBackendMode } from '../session';
import type { SessionSnapshot } from '../session';
import type { StreamSnapshot } from '../stream';
export function captureLabel(state: SessionSnapshot) {
  if (isBackendMode(state.mode)) {
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

export function diagramProgress(state: SessionSnapshot, stream: StreamSnapshot) {
  if (state.inFlight || stream.phase === 'receiving' || stream.phase === 'draining')
    return { label: 'Updating diagram', animated: true };
  if (state.generation === 'error' || state.capture === 'error')
    return { label: 'Updates need attention', animated: false };
  if (state.queued.length) {
    if (state.generation === 'paused') return { label: 'Updates paused', animated: false };
    const rateLimited = state.lastResult?.diagnostics.some(
      (entry) => entry.code === 'rate_limited',
    );
    return {
      label: rateLimited ? 'Waiting for API capacity' : 'Waiting to generate',
      animated: true,
    };
  }
  if (state.transcribingAudio || state.capture === 'finishing')
    return { label: 'Processing speech', animated: true };
  if (state.holdActive || state.capture === 'recording' || state.capture === 'requesting')
    return { label: 'Listening for more detail', animated: true };
  return null;
}
