import { useState, useSyncExternalStore } from 'react';
import type { RendererRuntime } from '../app/rendererRuntime';
import type { ApplyResult } from '../contracts';
export function Diagnostics({
  runtime,
  expanded = false,
}: {
  runtime: RendererRuntime;
  expanded?: boolean;
}) {
  const scene = useSyncExternalStore(
    runtime.store.subscribe,
    runtime.store.getSnapshot,
    runtime.store.getSnapshot,
  );
  const session = useSyncExternalStore(
    runtime.session.subscribe,
    runtime.session.getSnapshot,
    runtime.session.getSnapshot,
  );
  const stream = useSyncExternalStore(
    runtime.stream.consumer.subscribe,
    runtime.stream.consumer.getSnapshot,
    runtime.stream.consumer.getSnapshot,
  );
  const editor = useSyncExternalStore(
    runtime.editor.subscribe,
    runtime.editor.getSnapshot,
    runtime.editor.getSnapshot,
  );
  const [error, setError] = useState('');
  const busy =
    runtime.stream.consumer.isActive() ||
    ['recording', 'requesting'].includes(session.capture) ||
    session.queued.length > 0 ||
    session.inFlight ||
    session.canRetry;
  const result = (value: ApplyResult | undefined) =>
    setError(value?.status === 'rejected' ? value.message : '');
  return (
    <details className="developer-tools" open={expanded || undefined}>
      <summary>Developer tools</summary>
      <p className="muted">Development fixtures and request diagnostics.</p>
      <details>
        <summary>Request inspector</summary>
        {session.inspector ? (
          <>
            <p>
              Base revision: {session.inspector.request.baseRevision} · UTF-8 context:{' '}
              {session.inspector.bytes} bytes
            </p>
            <p>Transcript: {session.inspector.request.transcript.text}</p>
            <pre data-testid="request-json">{session.inspector.json}</pre>
          </>
        ) : (
          <p>No request sent yet.</p>
        )}
        <p>
          Queue age: {Math.round(session.queueAgeMs)} ms · Request latency:{' '}
          {session.modelLatencyMs === null ? '—' : `${Math.round(session.modelLatencyMs)} ms`}
        </p>
      </details>
      <details>
        <summary>
          Stream diagnostics · <span data-testid="stream-phase">{stream.phase}</span>
        </summary>
        <p>
          {stream.stats.applied} applied · {stream.stats.invalid + stream.stats.rejected} rejected ·{' '}
          {stream.stats.bytes} bytes · {stream.stats.queued} queued · {stream.stats.pending} pending
          · {stream.stats.discarded} discarded
        </p>
        <ul>
          {stream.diagnostics.map((d, i) => (
            <li key={i}>
              {d.code}: {d.message}
            </li>
          ))}
        </ul>
      </details>
      <div className="stack">
        <button
          disabled={busy || editor.interactionInProgress}
          onClick={() => {
            try {
              void runtime.stream.run();
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason));
            }
          }}
        >
          Run mock stream
        </button>
        <button
          disabled={!runtime.stream.consumer.isActive()}
          onClick={() => runtime.stream.consumer.cancel()}
        >
          Cancel mock
        </button>
        <button
          disabled={
            busy ||
            editor.interactionInProgress ||
            !runtime.stream.canRetry() ||
            !['error', 'incomplete', 'cancelled'].includes(stream.phase)
          }
          onClick={() => {
            void runtime.stream.run(true);
          }}
        >
          Retry mock
        </button>
      </div>
      <button
        disabled={!!Object.keys(scene.sections).length}
        onClick={() => result(runtime.loadFixture())}
      >
        Load renderer fixture
      </button>
      <details>
        <summary>Renderer fixture controls</summary>
        <p>Direct deterministic commands for renderer checks.</p>
        <div className="stack">
          <button
            disabled={!Object.keys(scene.sections).length}
            onClick={() => result(runtime.appendNode())}
          >
            Append distant fixture node
          </button>
          <button
            disabled={!Object.keys(scene.sections).length}
            onClick={() => result(runtime.appendTopic())}
          >
            Append topic
          </button>
          <button
            disabled={!Object.keys(scene.sections).length}
            onClick={() => result(runtime.growFirstSection())}
          >
            Grow first section
          </button>
          <button
            onClick={() => {
              if (window.confirm('Clear this board and its fixture content?'))
                runtime.session.reset({ confirmed: true });
            }}
          >
            Reset board
          </button>
        </div>
      </details>
      <p>
        Document revision: <output aria-label="Document revision">{scene.revision}</output>
      </p>
      {error && (
        <p role="status" className="recovery-note">
          {error}
        </p>
      )}
    </details>
  );
}
