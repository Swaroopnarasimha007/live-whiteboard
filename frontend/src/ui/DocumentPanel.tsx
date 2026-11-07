import { useRef, useSyncExternalStore } from 'react';
import type { RendererRuntime } from '../app/rendererRuntime';
export function DocumentPanel({ runtime }: { runtime: RendererRuntime }) {
  const state = useSyncExternalStore(
    runtime.document.subscribe,
    runtime.document.getSnapshot,
    runtime.document.getSnapshot,
  );
  const input = useRef<HTMLInputElement>(null);
  const labels: Record<string, string> = {
    idle: 'Autosave ready on this device',
    scheduled: 'Changes waiting to save',
    saving: 'Saving on this device…',
    saved: 'Saved on this device',
    restoring: 'Restoring saved drawing…',
    error: 'Local save needs attention',
    disabled: 'Autosave is off in this test harness',
    disposed: 'Document closed',
  };
  return (
    <section aria-label="Document">
      <h2>Document</h2>
      <p role="status" data-testid="save-state" data-state={state.saveState}>
        {labels[state.saveState]}
      </p>
      {state.message && <p className="recovery-note">{state.message}</p>}
      <div className="button-row">
        <button
          onClick={() => {
            const blob = new Blob([runtime.document.exportText()], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'whiteboard.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Export document
        </button>
        <button onClick={() => input.current?.click()}>Import document</button>
        <button
          disabled={
            state.saveState === 'disabled' ||
            state.saveState === 'saving' ||
            state.saveState === 'restoring'
          }
          onClick={() => {
            void runtime.document.flush();
          }}
        >
          Save now
        </button>
      </div>
      <input
        ref={input}
        className="sr-only"
        type="file"
        tabIndex={-1}
        accept=".json,application/json"
        aria-label="Import whiteboard JSON"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (
            file &&
            window.confirm(
              'Replace the current board with this document? Transcript and undo history will be cleared.',
            )
          )
            void runtime.document.importFile(file, true);
        }}
      />
      <p className="muted">
        Only the drawing is saved locally. Transcript and preview audio are not persisted. Export a
        file for a portable backup.
      </p>
    </section>
  );
}
