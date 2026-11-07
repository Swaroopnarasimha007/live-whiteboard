import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createRendererRuntime } from '../app/rendererRuntime';
import { RendererApp } from '../app/RendererApp';
import { prepareLayoutFonts } from '../layout';

/** Browser test composition and media resource instrumentation, not public API. */
export let activeHarness: ReturnType<typeof createRendererRuntime> & { unmount(): void };
export const capturedStreams: MediaStream[] = [];
export const revokedUrls: string[] = [];
export const mediaErrors: string[] = [];
export async function startHarness(contextBudgetBytes?: number) {
  await prepareLayoutFonts();
  const runtime = createRendererRuntime(
    contextBudgetBytes !== undefined ? { contextBudgetBytes } : {},
  );
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#f4f6f9';
  document.body.replaceChildren(host);
  const root = createRoot(host);
  root.render(createElement(RendererApp, { runtime }));
  activeHarness = {
    ...runtime,
    unmount: () => {
      root.unmount();
      runtime.dispose();
      host.remove();
    },
  };
  return activeHarness;
}
export function instrumentMedia() {
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    try {
      const stream = await getUserMedia(constraints);
      capturedStreams.push(stream);
      return stream;
    } catch (error) {
      mediaErrors.push(String(error));
      throw error;
    }
  };
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (url) => {
    revokedUrls.push(url);
    revoke(url);
  };
}
