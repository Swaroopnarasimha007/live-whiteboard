import { adaptRawFixtureTransport } from '../../src/stream/rawFixture';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createRendererRuntime, type RendererRuntime } from '../../src/app/rendererRuntime';
import { WhiteboardApp } from '../../src/ui';
import { prepareLayoutFonts } from '../../src/layout';
import { MockSpeechSource, type SpeechFixture } from '../../src/audio';
import {
  RawMockFixtureTransport as MockGenerationTransport,
  type MockTransportOptions,
} from '../../src/stream/mock';
import type { GenerationRequest, GenerationTransport, Scene } from '../../src/contracts';

export const requests: GenerationRequest[] = [];
export const commits: { time: number; scene: Scene }[] = [];
export let active: RendererRuntime;
export let release: () => void = () => {};
export let transportEnded = false;
export let unmount: () => void = () => {};
export async function start(
  options: {
    mock?: MockTransportOptions;
    speech?: SpeechFixture[];
    stall?: boolean;
    late?: boolean;
    staleLabel?: boolean;
    contextBudgetBytes?: number;
  } = {},
) {
  unmount();
  await prepareLayoutFonts();
  transportEnded = false;
  requests.length = 0;
  commits.length = 0;
  const transport: GenerationTransport = adaptRawFixtureTransport({
    async *generate(request, signal) {
      requests.push(request);
      if (options.staleLabel) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield new TextEncoder().encode(
          JSON.stringify({
            op: 'node.update',
            id: request.board.nodes[0]!.id,
            set: { label: 'Stale generated label' },
          }) + '\n',
        );
      } else if (options.stall || options.late) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield new TextEncoder().encode('{"op":"section.add","id":"late","title":"Late topic"}\n');
      } else {
        for await (const chunk of new MockGenerationTransport(options.mock).generate(
          request,
          signal,
        ))
          yield chunk;
      }
      transportEnded = true;
    },
  });
  active = createRendererRuntime({
    transport,
    speech: new MockSpeechSource(options.speech ?? []),
    ...(options.contextBudgetBytes !== undefined
      ? { contextBudgetBytes: options.contextBudgetBytes }
      : {}),
  });
  active.store.subscribe((scene) => commits.push({ time: performance.now(), scene }));
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:white;z-index:9999';
  document.body.replaceChildren(host);
  const runtime = active;
  const root = createRoot(host);
  root.render(createElement(WhiteboardApp, { runtime }));
  unmount = () => {
    root.unmount();
    runtime.dispose();
    host.remove();
  };
  return true;
}
export function submit(ids: string[] = ['demo-browser', 'demo-server', 'demo-edge']) {
  for (const [index, id] of ids.entries())
    active.session.ingest({
      id,
      text: id,
      startMs: index * 100,
      endMs: index * 100 + 100,
      isFinal: true,
    });
  active.session.sendNow();
}
