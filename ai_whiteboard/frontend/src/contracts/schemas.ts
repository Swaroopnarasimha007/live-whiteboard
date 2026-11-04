import { z } from 'zod';

export const DEFAULT_LIMITS = Object.freeze({ maxEntities: 5_000, maxSections: 100 });
const FORBIDDEN_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

// Inspect before Zod strips/normalizes anything, including records and nested patches.
export function isSafeData(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (depth > 100) return false;
  if (typeof value !== 'object' || value === null) return true;
  if (ancestors.has(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return false;
  ancestors.add(value);
  const safe = Object.entries(Object.getOwnPropertyDescriptors(value)).every(
    ([key, descriptor]) =>
      !FORBIDDEN_KEYS.has(key) &&
      'value' in descriptor &&
      isSafeData(descriptor.value, ancestors, depth + 1),
  );
  ancestors.delete(value);
  return safe;
}

function safe<T extends z.ZodType>(schema: T) {
  return z
    .unknown()
    .superRefine((value, ctx) => {
      if (!isSafeData(value))
        ctx.addIssue({ code: 'custom', message: 'Unsafe, cyclic or excessively nested data' });
    })
    .pipe(schema);
}

export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((id) => !FORBIDDEN_KEYS.has(id), 'Reserved identifier');
export const coordinateSchema = z.number().finite().min(-100_000).max(100_000);
export const dimensionSchema = z.number().finite().min(24).max(2_000);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const pointSchema = z.strictObject({ x: coordinateSchema, y: coordinateSchema });
export const boxSchema = pointSchema.extend({
  width: z.number().finite().nonnegative().max(200_000),
  height: z.number().finite().nonnegative().max(200_000),
});
export const shapeSchema = z.enum(['rect', 'roundRect', 'circle', 'ellipse', 'diamond', 'text']);
export const colorSchema = z.enum(['neutral', 'blue', 'green', 'orange', 'red', 'purple']);
export const sourceSchema = z.enum(['manual', 'generated']);
export function isEntityId(id: string, source: Source): boolean {
  return source === 'generated'
    ? /^g_.+/.test(id)
    : /^m_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
// Viewport translations are screen pixels, not bounded document/world coordinates.
export const viewportSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  scale: z.number().finite().min(0.15).max(4),
});
const entityFields = {
  id: idSchema,
  sectionId: idSchema,
  source: sourceSchema,
  locked: z.boolean(),
  revision: counter.min(1),
  lastManualRevision: counter,
};
const nodeObject = z.strictObject({
  ...entityFields,
  x: coordinateSchema,
  y: coordinateSchema,
  width: dimensionSchema,
  height: dimensionSchema,
  type: shapeSchema,
  label: z.string().max(500),
  color: colorSchema,
  sizing: z.enum(['auto', 'fixed']),
});
export const nodeSchema = nodeObject.superRefine((node, ctx) => {
  if (node.type === 'circle' && node.width !== node.height)
    ctx.addIssue({ code: 'custom', message: 'Circle dimensions must match' });
  if (!node.label.trim() && node.source !== 'manual')
    ctx.addIssue({ code: 'custom', message: 'Only manual placeholders may have empty labels' });
});
export const edgeSchema = z.strictObject({
  ...entityFields,
  from: idSchema,
  to: idSchema,
  kind: z.enum(['arrow', 'line']),
  label: z.string().max(200),
  color: colorSchema,
});
export const sectionSchema = z.strictObject({
  id: idSchema,
  title: z.string().min(1).max(120),
  order: counter,
  origin: pointSchema,
  bounds: boxSchema,
});

export interface SceneLimits {
  maxEntities: number;
  maxSections: number;
}
export function createSceneSchema(limits: SceneLimits = DEFAULT_LIMITS) {
  return safe(
    z
      .strictObject({
        schemaVersion: z.literal(1),
        documentId: idSchema,
        revision: counter,
        sections: z.record(idSchema, sectionSchema),
        nodes: z.record(idSchema, nodeSchema),
        edges: z.record(idSchema, edgeSchema),
      })
      .superRefine((scene, ctx) => {
        const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
        const ids = new Set<string>();
        const orders = new Set<number>();
        if (Object.keys(scene.sections).length > limits.maxSections)
          issue('Section limit exceeded');
        if (Object.keys(scene.nodes).length + Object.keys(scene.edges).length > limits.maxEntities)
          issue('Entity limit exceeded');
        for (const collection of [scene.sections, scene.nodes, scene.edges]) {
          for (const [key, entity] of Object.entries(collection)) {
            if (key !== entity.id || ids.has(entity.id))
              issue('Entity keys and globally unique IDs must match');
            ids.add(entity.id);
          }
        }
        for (const section of Object.values(scene.sections)) {
          if (
            (!isEntityId(section.id, 'generated') && !isEntityId(section.id, 'manual')) ||
            scene.revision === 0
          )
            issue('Invalid section identity or revision');
          if (orders.has(section.order)) issue('Section orders must be unique');
          orders.add(section.order);
        }
        for (const entity of [...Object.values(scene.nodes), ...Object.values(scene.edges)]) {
          if (
            !isEntityId(entity.id, entity.source) ||
            (entity.source === 'manual' && entity.lastManualRevision === 0)
          )
            issue('Invalid entity identity or source revision');
          if (!scene.sections[entity.sectionId]) issue('Missing section');
          if (entity.revision > scene.revision || entity.lastManualRevision > scene.revision)
            issue('Entity revision exceeds document revision');
        }
        for (const edge of Object.values(scene.edges)) {
          const from = scene.nodes[edge.from];
          const to = scene.nodes[edge.to];
          if (
            !from ||
            !to ||
            from.id === to.id ||
            from.sectionId !== edge.sectionId ||
            to.sectionId !== edge.sectionId
          )
            issue('Invalid edge endpoints');
        }
      }),
  );
}
export const sceneSchema = createSceneSchema();

const atSchema = z.tuple([coordinateSchema, coordinateSchema]);
export const placementSchema = z.union([
  z.strictObject({ rightOf: idSchema }),
  z.strictObject({ below: idSchema }),
  z.strictObject({ leftOf: idSchema }),
  z.strictObject({ above: idSchema }),
]);
const label = z.string().max(500);
const nodeSet = z
  .strictObject({
    label: label.optional(),
    color: colorSchema.optional(),
    type: shapeSchema.optional(),
    at: atSchema.optional(),
  })
  .refine((set) => Object.values(set).some((value) => value !== undefined), 'Empty update');
const sectionAdd = z.strictObject({
  op: z.literal('section.add'),
  id: idSchema,
  title: z.string().min(1).max(120),
});
const nodeAdd = z
  .strictObject({
    op: z.literal('node.add'),
    id: idSchema,
    section: idSchema,
    type: shapeSchema,
    label,
    color: colorSchema.default('neutral'),
    at: atSchema.optional(),
    place: placementSchema.optional(),
  })
  .refine((op) => !(op.at && op.place), 'Use at OR place');
const edgeAdd = z.strictObject({
  op: z.literal('edge.add'),
  id: idSchema,
  section: idSchema,
  from: idSchema,
  to: idSchema,
  kind: z.enum(['arrow', 'line']).default('arrow'),
  label: z.string().max(200).default(''),
  color: colorSchema.default('neutral'),
});
const nodeUpdate = z.strictObject({ op: z.literal('node.update'), id: idSchema, set: nodeSet });
const edgeUpdate = z.strictObject({
  op: z.literal('edge.update'),
  id: idSchema,
  set: z
    .strictObject({ label: z.string().max(200).optional(), color: colorSchema.optional() })
    .refine((set) => Object.values(set).some((value) => value !== undefined), 'Empty update'),
});
const entityDelete = z.strictObject({ op: z.literal('entity.delete'), id: idSchema });
const operations = [sectionAdd, nodeAdd, edgeAdd, nodeUpdate, edgeUpdate, entityDelete] as const;
export const operationSchema = safe(
  z.discriminatedUnion('op', operations).superRefine((op, ctx) => {
    const value =
      op.op === 'node.add' ? op.label : op.op === 'node.update' ? op.set.label : undefined;
    if (value !== undefined && !value.trim())
      ctx.addIssue({ code: 'custom', message: 'Generated labels must not be empty' });
  }),
);
export const manualCommandSchema = safe(
  z.discriminatedUnion('op', [
    ...operations,
    z.strictObject({
      op: z.literal('node.resize'),
      id: idSchema,
      width: dimensionSchema,
      height: dimensionSchema,
      at: atSchema.optional(),
    }),
    z.strictObject({ op: z.literal('entity.lock'), id: idSchema, locked: z.boolean() }),
    z.strictObject({
      op: z.literal('section.rename'),
      id: idSchema,
      title: z.string().min(1).max(120),
    }),
  ]),
);
export const commandMetaSchema = safe(
  z
    .strictObject({
      source: sourceSchema,
      requestId: idSchema.optional(),
      baseRevision: counter.optional(),
      sequence: counter.optional(),
      sessionEpoch: counter,
      transactionId: idSchema,
    })
    .superRefine((meta, ctx) => {
      if (
        meta.source === 'generated' &&
        (meta.requestId === undefined ||
          meta.baseRevision === undefined ||
          meta.sequence === undefined)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Generated commands require requestId, baseRevision and sequence',
        });
    }),
);

const contextNode = nodeObject.pick({
  id: true,
  sectionId: true,
  type: true,
  label: true,
  color: true,
  x: true,
  y: true,
  width: true,
  height: true,
  locked: true,
  source: true,
  revision: true,
});
const contextEdge = edgeSchema.pick({
  source: true,
  locked: true,
  revision: true,
  id: true,
  sectionId: true,
  from: true,
  to: true,
  kind: true,
  label: true,
  color: true,
});
export const generationRequestSchema = safe(
  z
    .strictObject({
      protocolVersion: z.literal(1),
      requestId: idSchema,
      sessionId: idSchema,
      sessionEpoch: counter,
      baseRevision: counter,
      idPrefix: idSchema.refine(
        (id) => /^g_.+_$/.test(id),
        'Generated prefix must start g_ and end _',
      ),
      transcript: z
        .strictObject({
          segmentIds: z
            .array(idSchema)
            .min(1)
            .refine((ids) => new Set(ids).size === ids.length, 'Duplicate segment IDs'),
          text: z.string().min(1).max(10_000),
          startMs: z.number().finite().nonnegative(),
          endMs: z.number().finite().nonnegative(),
        })
        .refine((t) => t.endMs >= t.startMs, 'Invalid transcript interval'),
      board: z.strictObject({
        activeSectionId: idSchema.nullable(),
        sections: z.array(sectionSchema.omit({ order: true })).max(100),
        nodes: z.array(contextNode).max(5_000),
        edges: z.array(contextEdge).max(5_000),
        viewport: viewportSchema,
        visibleWorldBounds: boxSchema,
        selectedIds: z.array(idSchema),
        contextComplete: z.literal(true),
        omittedEntityCount: z.literal(0),
      }),
    })
    .superRefine((request, ctx) => {
      const { board } = request;
      const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
      const all = [...board.sections, ...board.nodes, ...board.edges];
      const ids = new Set(all.map((e) => e.id));
      const sections = new Set(board.sections.map((s) => s.id));
      const nodes = new Map(board.nodes.map((n) => [n.id, n]));
      if (ids.size !== all.length || board.nodes.length + board.edges.length > 5_000)
        issue('Duplicate IDs or entity limit exceeded');
      if (board.activeSectionId !== null && !sections.has(board.activeSectionId))
        issue('Missing active section');
      if (
        new Set(board.selectedIds).size !== board.selectedIds.length ||
        board.selectedIds.some((id) => !ids.has(id))
      )
        issue('Invalid selection');
      for (const node of board.nodes) {
        if (
          !isEntityId(node.id, node.source) ||
          !sections.has(node.sectionId) ||
          node.revision > request.baseRevision ||
          (node.type === 'circle' && node.width !== node.height) ||
          (!node.label.trim() && node.source !== 'manual')
        )
          issue('Invalid context node');
      }
      for (const edge of board.edges) {
        const from = nodes.get(edge.from);
        const to = nodes.get(edge.to);
        if (
          !from ||
          !to ||
          from.id === to.id ||
          !sections.has(edge.sectionId) ||
          !isEntityId(edge.id, edge.source) ||
          edge.revision > request.baseRevision ||
          from.sectionId !== edge.sectionId ||
          to.sectionId !== edge.sectionId
        )
          issue('Invalid context edge');
      }
    }),
);

export type Point = z.infer<typeof pointSchema>;
export type Box = z.infer<typeof boxSchema>;
export type Shape = z.infer<typeof shapeSchema>;
export type Color = z.infer<typeof colorSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Node = z.infer<typeof nodeSchema>;
export type Edge = z.infer<typeof edgeSchema>;
export type Section = z.infer<typeof sectionSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Viewport = z.infer<typeof viewportSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type ManualCommand = z.infer<typeof manualCommandSchema>;
export type Command = ManualCommand;
export type CommandMeta = z.infer<typeof commandMetaSchema>;
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type Placement = z.infer<typeof placementSchema>;
const eventBase = {
  wireVersion: z.literal(1),
  requestId: idSchema,
  sessionEpoch: counter,
  sequence: counter.min(1),
};
export const generationEventSchema = safe(
  z.discriminatedUnion('event', [
    z.strictObject({ ...eventBase, event: z.literal('started'), baseRevision: counter }),
    z.strictObject({
      ...eventBase,
      event: z.literal('operation'),
      baseRevision: counter,
      operation: operationSchema,
    }),
    z.strictObject({
      ...eventBase,
      event: z.literal('warning'),
      code: z.string(),
      message: z.string(),
    }),
    z.strictObject({
      ...eventBase,
      event: z.literal('completed'),
      operationCount: counter,
      warningCount: counter,
    }),
    z.strictObject({
      ...eventBase,
      event: z.literal('failed'),
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().default(false),
    }),
    z.strictObject({ ...eventBase, event: z.literal('cancelled'), reason: z.string() }),
  ]),
);
export type GenerationEvent = z.infer<typeof generationEventSchema>;
export interface GenerationTransport {
  generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent>;
}

export const errorCodeSchema = z.enum([
  'VALIDATION',
  'STALE_EPOCH',
  'FUTURE_REVISION',
  'DUPLICATE_ID',
  'REPLAY_CONFLICT',
  'TOMBSTONED',
  'MISSING_DEPENDENCY',
  'PENDING_LIMIT',
  'PROTECTED',
  'LOCKED',
  'ACTIVE_EDIT',
  'STALE_MANUAL_EDIT',
  'WRONG_ENTITY',
  'INVALID_REFERENCE',
  'LIMIT',
  'LAYOUT',
  'HISTORY_CONFLICT',
  'EMPTY_HISTORY',
  'IMPORT',
  'DISPOSED',
  'REQUEST_ENDED',
  'TRANSACTION_REUSE',
  'REENTRANT',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ApplyResult =
  | { status: 'applied' | 'duplicate'; revision: number }
  | { status: 'pending'; reason: string }
  | { status: 'rejected'; code: ErrorCode; message: string };
