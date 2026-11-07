import {
  generationRequestSchema,
  type Box,
  type GenerationRequest,
  type Scene,
  type Viewport,
} from '../contracts';
import { freeze } from '../stream/types';

export const DEFAULT_CONTEXT_BUDGET = 256 * 1024;
export class ContextError extends Error {
  readonly code: 'INTERACTION_ACTIVE' | 'CONTEXT_LIMIT';
  constructor(code: ContextError['code'], message: string) {
    super(message);
    this.name = 'ContextError';
    this.code = code;
  }
}
export interface ContextView {
  viewport: Viewport;
  visibleWorldBounds: Box;
  selectedIds: readonly string[];
  activeSectionId: string | null;
  interactionInProgress: boolean;
}
export interface BuildGenerationRequestOptions extends ContextView {
  scene: Scene;
  sessionEpoch: number;
  sessionId: string;
  requestId: string;
  transcript: GenerationRequest['transcript'];
  budgetBytes?: number;
}
export function inspectGenerationRequest(request: GenerationRequest) {
  const json = JSON.stringify(request);
  return { json, bytes: new TextEncoder().encode(json).byteLength };
}
/** Full canonical context only; never truncates, summarizes or reads native preview geometry. */
export function buildGenerationRequest(options: BuildGenerationRequestOptions): GenerationRequest {
  if (options.interactionInProgress)
    throw new ContextError('INTERACTION_ACTIVE', 'Finish the active edit before sending context.');
  const budget = options.budgetBytes ?? DEFAULT_CONTEXT_BUDGET;
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('Invalid context byte budget');
  const scene = options.scene;
  const request = generationRequestSchema.parse({
    protocolVersion: 1,
    requestId: options.requestId,
    sessionId: options.sessionId,
    sessionEpoch: options.sessionEpoch,
    baseRevision: scene.revision,
    idPrefix: `g_${options.requestId}_`,
    transcript: options.transcript,
    board: {
      activeSectionId: options.activeSectionId,
      sections: Object.values(scene.sections)
        .sort((a, b) => a.order - b.order)
        .map(({ id, title, origin, bounds }) => ({ id, title, origin, bounds })),
      nodes: Object.values(scene.nodes).map(
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
      edges: Object.values(scene.edges).map(
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
      viewport: options.viewport,
      visibleWorldBounds: options.visibleWorldBounds,
      selectedIds: options.selectedIds,
      contextComplete: true,
      omittedEntityCount: 0,
    },
  });
  const { bytes } = inspectGenerationRequest(request);
  if (bytes > budget)
    throw new ContextError(
      'CONTEXT_LIMIT',
      `Full context is ${bytes} bytes; limit is ${budget}. Reduce the board or raise the context budget, then Send now. Transcript is retained.`,
    );
  return freeze(request);
}
