import { useSyncExternalStore } from 'react';
import type { RendererRuntime } from '../app/rendererRuntime';
import type { SessionMode } from '../session';
export function TranscriptPanel({
  runtime,
  mode,
}: {
  runtime: RendererRuntime;
  mode: SessionMode;
}) {
  const state = useSyncExternalStore(
    runtime.session.subscribe,
    runtime.session.getSnapshot,
    runtime.session.getSnapshot,
  );
  return (
    <section className="transcript-pane" aria-label="Transcript">
      <h2>
        Transcript <span className="muted">({state.transcript.length})</span>
      </h2>
      <div className="transcript-scroll" tabIndex={0} aria-label="Transcript entries">
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
        {!state.transcript.length && !state.interim && (
          <p className="muted">Your transcript will appear here.</p>
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
      </div>
    </section>
  );
}
