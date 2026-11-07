import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { prepareLayoutFonts } from '../layout';
import { createRendererRuntime } from '../app/rendererRuntime';
import { RendererApp } from '../app/RendererApp';

/** Browser-test composition only, deliberately absent from the public barrel. */
export let activeHarness: Awaited<ReturnType<typeof mountHarness>>;
async function mountHarness() {
  await prepareLayoutFonts();
  const runtime = createRendererRuntime();
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#f4f6f9';
  document.body.replaceChildren(host);
  const root = createRoot(host);
  root.render(createElement(RendererApp, { runtime }));
  return runtime;
}
export async function startHarness() {
  activeHarness = await mountHarness();
}
