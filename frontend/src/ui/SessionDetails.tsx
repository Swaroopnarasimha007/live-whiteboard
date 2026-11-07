import { ProfilePicker } from '../session/backend/ProfilePicker';
import { useSyncExternalStore } from 'react';
import type { RendererRuntime } from '../app/rendererRuntime';
import type { SessionMode } from '../session';
export function SessionDetails({ runtime, mode }: { runtime: RendererRuntime; mode: SessionMode }) {
  const session = runtime.session;
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const mic = useSyncExternalStore(
    session.microphone.subscribe,
    session.microphone.getSnapshot,
    session.microphone.getSnapshot,
  );
  return (
    <section aria-label="Session details">
      <h2>Session</h2>
      <p className="muted">
        {mode === 'mock'
          ? 'Mock demo · no microphone needed'
          : mode === 'backend'
            ? 'Whisper · hold to talk, release to draw'
            : 'Local recording — transcription mocked'}
      </p>
      {mode === 'backend' && (
        <ProfilePicker
          bridge={runtime.backend}
          disabled={
            state.inFlight || state.capture === 'recording' || state.capture === 'requesting'
          }
        />
      )}
      <p>
        {state.queued.length
          ? `${state.queued.length} final segments waiting to send.`
          : 'No transcript waiting.'}
      </p>
      {state.message && (
        <p className="recovery-note" role="status">
          {state.message}
        </p>
      )}
      <div className="panel-actions">
        <button
          disabled={!state.queued.length || state.inFlight || state.canRetry}
          onClick={session.sendNow}
          title="Send finalized queued text now"
        >
          Send now
        </button>
        <button
          disabled={!state.canRetry || state.inFlight}
          onClick={session.retry}
          title="Retry the original request; keep accepted drawing"
        >
          {mode === 'backend' ? 'Replay retained request' : 'Retry request'}
        </button>
        {mode === 'backend' && (
          <button disabled={!state.canRetry || state.inFlight} onClick={session.continueFresh}>
            Continue with fresh context
          </button>
        )}
      </div>
      <details>
        <summary>Transcript ({state.transcript.length})</summary>
        <p className="muted">
          {mode === 'backend'
            ? 'Audio uses the selected backend speech profile.'
            : 'Transcription is mocked in standalone modes.'}{' '}
          Only finalized audio chunks create drawing requests. Longer holds update the drawing
          progressively.
        </p>
        {state.interim && (
          <p className="interim" data-testid="interim-transcript">
            Interim: {state.interim.text}
          </p>
        )}
        {state.hiddenTranscriptCount > 0 && (
          <p>
            {state.hiddenTranscriptCount} older display entries hidden; pending text is retained.
          </p>
        )}
        <ol className="transcript-list">
          {state.transcript.map((event) => (
            <li key={event.id}>
              <p>{event.text}</p>
              <small>
                Final · {event.status} · {(event.startMs / 1000).toFixed(1)}–
                {(event.endMs / 1000).toFixed(1)} s
              </small>
            </li>
          ))}
        </ol>
      </details>
      {mode === 'microphone' && (
        <details open>
          <summary>{mic.label}</summary>
          <p>
            {Math.round(mic.retainedMs / 1000)} seconds retained ·{' '}
            {Math.round(mic.droppedMs / 1000)} seconds discarded
          </p>
          <p className={mic.state === 'error' ? 'recovery-note' : 'muted'}>
            {mic.message ||
              'Audio stays in memory on this device. Pause to listen; Stop discards previews.'}
          </p>
          {mic.clips.map((clip) => (
            <audio
              key={clip.id}
              controls
              src={clip.url}
              aria-label={`Local preview ${clip.id}`}
              preload="metadata"
            />
          ))}
        </details>
      )}
      <button
        className="text-button danger"
        title="Clear this board and transcript after confirmation"
        onClick={() => {
          if (window.confirm('Clear the board, transcript and current session?'))
            session.reset({ confirmed: true });
        }}
      >
        Reset session
      </button>
    </section>
  );
}
