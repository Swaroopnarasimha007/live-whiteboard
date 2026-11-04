import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createRendererRuntime } from '../../app/rendererRuntime';
import { RendererApp } from '../../app/RendererApp';
import { prepareLayoutFonts } from '../../layout';

export let runtime: ReturnType<typeof createRendererRuntime>;
export const observed: { nodes: number; inFlight: boolean; phase: string | undefined }[] = [];
export let activeCaptures = 0;
export let capturedSamples = 0;
/** Deterministic PCM fixture uses real WS/HTTP, without microphone permission or model credentials. */
export async function startHarness(pcm?: number[], denied = false) {
  capturedSamples = 0;
  await prepareLayoutFonts();
  runtime = createRendererRuntime({
    backend: {
      baseUrl: 'http://127.0.0.1:8013',
      audioEnvironment: {
        secure: true,
        supported: true,
        connect: (url) => new WebSocket(url),
        capture: async (frame, _failure, frameMs, _max, signal) => {
          if (denied) throw new DOMException('Denied', 'NotAllowedError');
          activeCaptures++;
          let offset = 0;
          const timer = setInterval(
            () => {
              if (pcm) {
                const data = new Uint8Array(pcm.slice(offset, offset + 32 * frameMs));
                if (!data.length) return;
                offset += data.length;
                capturedSamples += data.length / 2;
                frame(data.buffer);
              } else frame(new ArrayBuffer(32 * frameMs));
            },
            pcm ? 10 : frameMs,
          );
          let stopped = false;
          const stop = async () => {
            if (!stopped) {
              stopped = true;
              clearInterval(timer);
              activeCaptures--;
            }
          };
          signal.addEventListener(
            'abort',
            () => {
              void stop();
            },
            { once: true },
          );
          return { finish: stop, abort: stop, credit: () => {} };
        },
      },
    },
  });
  runtime.store.subscribe(() =>
    observed.push({
      nodes: Object.keys(runtime.store.getSnapshot().nodes).length,
      inFlight: runtime.session.getSnapshot().inFlight,
      phase: runtime.stream.consumer.getSnapshot().phase,
    }),
  );
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  createRoot(host).render(createElement(RendererApp, { runtime }));
}
