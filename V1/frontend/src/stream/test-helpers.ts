import { adaptRawFixtureTransport } from './rawFixture';
import type { GenerationRequest, GenerationTransport } from '../contracts';
import { generationRequestSchema } from '../contracts';
import type { SceneStore } from '../scene';
import type { FrameClock } from './scheduler';

export function requestFor(
  store: SceneStore,
  overrides: Partial<GenerationRequest> = {},
): GenerationRequest {
  const s = store.getSnapshot();
  return generationRequestSchema.parse({
    protocolVersion: 1,
    requestId: 'r1',
    sessionId: 'session1',
    sessionEpoch: store.getSessionEpoch(),
    baseRevision: s.revision,
    idPrefix: 'g_r1_',
    transcript: {
      segmentIds: ['demo-browser', 'demo-server', 'demo-edge'],
      text: 'Browser sends a request to the server',
      startMs: 0,
      endMs: 2_000,
    },
    board: {
      activeSectionId: Object.keys(s.sections)[0] ?? null,
      sections: Object.values(s.sections).map(({ id, title, origin, bounds }) => ({
        id,
        title,
        origin,
        bounds,
      })),
      nodes: Object.values(s.nodes).map(
        ({ id, sectionId, type, label, color, x, y, width, height, locked, source, revision }) => ({
          id,
          sectionId,
          type,
          label,
          color,
          x,
          y,
          width,
          height,
          locked,
          source,
          revision,
        }),
      ),
      edges: Object.values(s.edges).map(
        ({ id, sectionId, from, to, kind, label, color, source, locked, revision }) => ({
          source,
          locked,
          revision,
          id,
          sectionId,
          from,
          to,
          kind,
          label,
          color,
        }),
      ),
      viewport: { x: 0, y: 0, scale: 1 },
      visibleWorldBounds: { x: 0, y: 0, width: 800, height: 600 },
      selectedIds: [],
      contextComplete: true,
      omittedEntityCount: 0,
    },
    ...overrides,
  });
}
export function bytesTransport(
  text: string,
  chunkSize = 64,
  limits: { maxLineBytes?: number; maxPartialBytes?: number } = {},
): GenerationTransport {
  return adaptRawFixtureTransport(
    {
      async *generate() {
        const bytes = new TextEncoder().encode(text);
        for (let offset = 0; offset < bytes.length; offset += chunkSize)
          yield bytes.slice(offset, offset + chunkSize);
      },
    },
    limits,
  );
}
export function frameClock() {
  let now = 0;
  let id = 0;
  const callbacks = new Map<number, () => void>();
  const clock: FrameClock = {
    now: () => now,
    request: (callback) => {
      callbacks.set(++id, callback);
      return id;
    },
    cancel: (id) => {
      callbacks.delete(id);
    },
  };
  return {
    clock,
    callbacks,
    cost: (ms: number) => {
      now += ms;
    },
    tick: () => {
      now += 16;
      const ready = [...callbacks.values()];
      callbacks.clear();
      ready.forEach((cb) => cb());
    },
  };
}
