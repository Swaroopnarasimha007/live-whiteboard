import { isSafeData, layoutOutputSchema, type LayoutOutput } from '../contracts';
import { SceneError } from './utils';

export function validateLayout(output: unknown): LayoutOutput {
  if (!isSafeData(output)) throw new SceneError('LAYOUT', 'Unsafe layout result');
  const result = layoutOutputSchema.safeParse(output);
  if (!result.success) throw new SceneError('LAYOUT', result.error.message);
  return {
    nodes: result.data.nodes,
    sections: result.data.sections,
    ...(result.data.diagnostics !== undefined ? { diagnostics: result.data.diagnostics } : {}),
    ...(result.data.anchorDelta !== undefined ? { anchorDelta: result.data.anchorDelta } : {}),
  };
}
