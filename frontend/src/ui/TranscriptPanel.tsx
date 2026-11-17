import { isBackendMode } from '../session';
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
  const rateLimited = state.lastResult?.diagnostics.some((entry) => entry.code === 'rate_limited');
  const statusLabels = {
    queued:
      state.generation === 'paused'
        ? 'Waiting to resume'
        : state.inFlight
          ? 'Waiting for current generation'
          : rateLimited
            ? 'Waiting for API rate limit to reset'
            : 'Waiting to generate',
    sent: 'Generating diagram',
    completed: 'Drawn',
    failed: 'Not drawn yet',
  };
  return (
    <section className="transcript-pane" aria-label="Transcript">
      <h2>
        Transcript <span className="muted">({state.transcript.length})</span>
      </h2>
      <div className="transcript-scroll" tabIndex={0} aria-label="Transcript entries">
        <p className="muted">
          {isBackendMode(mode)
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
                Final · {statusLabels[event.status]} · {(event.startMs / 1000).toFixed(1)}–
                {(event.endMs / 1000).toFixed(1)} s
              </small>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
