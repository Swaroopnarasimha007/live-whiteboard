import { useEffect, useState } from 'react';
import { prepareLayoutFonts } from '../layout';
import { createRendererRuntime, type RendererRuntime } from './rendererRuntime';
import { RendererApp } from './RendererApp';
import { createIndexedDbPersistence } from '../scene';

export function App() {
  const [runtime, setRuntime] = useState<RendererRuntime | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let resources: RendererRuntime | undefined;
    void prepareLayoutFonts()
      .then(async () => {
        if (cancelled) return;
        resources = createRendererRuntime({ persistence: createIndexedDbPersistence() });
        await resources.document.restore();
        if (!cancelled) setRuntime(resources);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      resources?.dispose();
    };
  }, []);
  if (error)
    return (
      <main className="board-loading" role="alert">
        <h1>Unable to prepare the board</h1>
        <p>{error}</p>
      </main>
    );
  if (!runtime)
    return (
      <main className="board-loading">
        <h1>Live Whiteboard</h1>
        <p role="status">Preparing board fonts…</p>
      </main>
    );
  return <RendererApp runtime={runtime} />;
}
