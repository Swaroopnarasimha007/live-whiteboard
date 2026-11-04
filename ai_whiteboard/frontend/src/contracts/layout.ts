import { z } from 'zod';
import {
  boxSchema,
  dimensionSchema,
  idSchema,
  pointSchema,
  type Box,
  type Command,
  type CommandMeta,
  type Node,
  type Point,
  type Scene,
} from './schemas';

export const layoutOutputSchema = z.strictObject({
  nodes: z.record(
    idSchema,
    pointSchema.extend({ width: dimensionSchema, height: dimensionSchema }),
  ),
  sections: z.record(idSchema, z.strictObject({ origin: pointSchema, bounds: boxSchema })),
  diagnostics: z.array(z.string()).optional(),
  anchorDelta: z
    .strictObject({
      x: z.number().finite().min(-200_000).max(200_000),
      y: z.number().finite().min(-200_000).max(200_000),
    })
    .optional(),
});

export interface NodeGeometry extends Point {
  width: number;
  height: number;
}
export interface LayoutInput {
  readonly previousScene: Scene;
  readonly scene: Scene;
  readonly commands: readonly Command[];
  readonly meta: CommandMeta;
  /** These nodes have provisional dimensions: the adapter MUST return their geometry. */
  readonly measureNodeIds: readonly string[];
  /** New nodes need positioning using at/place and the latest scene. */
  readonly addedNodeIds: readonly string[];
}
export interface LayoutOutput {
  nodes: Record<string, NodeGeometry>;
  /** Every section must be included; origin/bounds are section geometry only. */
  sections: Record<string, { origin: Point; bounds: Box }>;
  diagnostics?: readonly string[];
  /** For Agent 3 to compensate its viewport when downstream origins shift. */
  anchorDelta?: Point;
}
/** Pure synchronous adapter; scene owns validation/atomic commit, Agent 2 owns geometry. */
export interface SceneLayout {
  layoutTransaction(input: LayoutInput): LayoutOutput;
}
export type MeasurableNode = Pick<Node, 'type' | 'label'>;
