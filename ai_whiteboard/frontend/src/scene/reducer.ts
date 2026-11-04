import {
  createSceneSchema,
  isEntityId,
  type Command,
  type CommandMeta,
  type Scene,
  type SceneLayout,
  type SceneLimits,
} from '../contracts';
import { validateLayout } from './geometry';
import { equal, freeze, SceneError, stable } from './utils';

export interface ReducerState {
  readonly scene: Scene;
  readonly tombstones: ReadonlySet<string>;
  readonly additions: ReadonlyMap<string, string>;
}
export interface ReducerContext {
  layout: SceneLayout;
  limits: SceneLimits;
  editingIds: ReadonlySet<string>;
}
export interface Reduction {
  state: ReducerState;
  manualIds: ReadonlySet<string>;
  diagnostics: readonly string[];
  anchorDelta?: { x: number; y: number };
}

export function reduceScene(
  state: ReducerState,
  commands: readonly Command[],
  meta: CommandMeta,
  context: ReducerContext,
): Reduction {
  const { scene: previous } = state;
  const scene = structuredClone(previous);
  const tombstones = new Set(state.tombstones);
  const additions = new Map(state.additions);
  const changed = new Set<string>();
  const measured = new Set<string>();
  const positioned = new Set<string>();
  const added = new Set<string>();
  const manualIds = new Set<string>();
  const fail = (code: ConstructorParameters<typeof SceneError>[0], message: string): never => {
    throw new SceneError(code, message);
  };
  const find = (id: string) => scene.nodes[id] ?? scene.edges[id] ?? scene.sections[id];
  const dependency = (id: string) => {
    if (find(id)) return;
    if (tombstones.has(id)) fail('TOMBSTONED', `Deleted dependency: ${id}`);
    fail('MISSING_DEPENDENCY', `Missing dependency: ${id}`);
  };
  const protect = (id: string, unlock = false) => {
    dependency(id);
    const entity = scene.nodes[id] ?? scene.edges[id];
    if (!entity) return fail('WRONG_ENTITY', `Expected node or edge: ${id}`);
    if (entity.locked && !unlock) fail('LOCKED', `Entity is locked: ${id}`);
    if (meta.source === 'generated') {
      if (entity.source === 'manual') fail('PROTECTED', `Manual entity: ${id}`);
      if (context.editingIds.has(id)) fail('ACTIVE_EDIT', `Entity is being edited: ${id}`);
      if (entity.lastManualRevision > meta.baseRevision!)
        fail('STALE_MANUAL_EDIT', `Manual edit newer than request: ${id}`);
    }
    return entity;
  };
  const touch = (id: string) => {
    changed.add(id);
    if (meta.source === 'manual') manualIds.add(id);
  };
  const validId = (id: string) => {
    if (!isEntityId(id, meta.source))
      fail('VALIDATION', `New ${meta.source} ID has invalid namespace: ${id}`);
  };
  const base = (id: string, sectionId: string) => ({
    id,
    sectionId,
    source: meta.source,
    locked: false,
    revision: 0,
    lastManualRevision: 0,
  });

  for (const command of commands) {
    const id = command.id;
    const references =
      command.op === 'node.add'
        ? [command.section, ...(command.place ? Object.values(command.place) : [])]
        : command.op === 'edge.add'
          ? [command.section, command.from, command.to]
          : [];
    for (const ref of references)
      if (!find(ref) && tombstones.has(ref)) fail('TOMBSTONED', `Deleted dependency: ${ref}`);
    if (command.op.endsWith('.add')) {
      const existing = find(id);
      if (existing) {
        if (additions.get(id) === stable({ source: meta.source, command })) continue;
        fail('DUPLICATE_ID', `Conflicting existing ID: ${id}`);
      }
      if (tombstones.has(id)) fail('TOMBSTONED', `Cannot reuse deleted ID: ${id}`);
      validId(id);
    }
    switch (command.op) {
      case 'section.add': {
        const order = Math.max(-1, ...Object.values(scene.sections).map((s) => s.order)) + 1;
        scene.sections[id] = {
          id,
          title: command.title,
          order,
          origin: { x: 0, y: 0 },
          bounds: { x: 0, y: 0, width: 0, height: 0 },
        };
        touch(id);
        break;
      }
      case 'node.add': {
        dependency(command.section);
        if (!scene.sections[command.section]) fail('WRONG_ENTITY', 'Expected section');
        if (command.place) {
          const anchorId = Object.values(command.place)[0] as string;
          dependency(anchorId);
          if (scene.nodes[anchorId]?.sectionId !== command.section)
            fail('INVALID_REFERENCE', 'Placement anchor must be a node in the same section');
        }
        scene.nodes[id] = {
          ...base(id, command.section),
          type: command.type,
          label: command.label,
          color: command.color,
          x: command.at?.[0] ?? 0,
          y: command.at?.[1] ?? 0,
          width: 24,
          height: 24,
          sizing: 'auto',
        };
        measured.add(id);
        added.add(id);
        touch(id);
        break;
      }
      case 'edge.add': {
        // Inspect ALL missing references for tombstones before choosing a dependency to wait on.
        for (const ref of [command.section, command.from, command.to])
          if (!find(ref) && tombstones.has(ref)) fail('TOMBSTONED', `Deleted dependency: ${ref}`);
        [command.section, command.from, command.to].forEach(dependency);
        if (
          !scene.sections[command.section] ||
          command.from === command.to ||
          scene.nodes[command.from]?.sectionId !== command.section ||
          scene.nodes[command.to]?.sectionId !== command.section
        )
          fail('INVALID_REFERENCE', 'Edges require two distinct nodes in the same section');
        scene.edges[id] = {
          ...base(id, command.section),
          from: command.from,
          to: command.to,
          kind: command.kind,
          label: command.label,
          color: command.color,
        };
        touch(id);
        break;
      }
      case 'node.update': {
        protect(id);
        const node = scene.nodes[id];
        if (!node) fail('WRONG_ENTITY', 'Expected node');
        const { at, ...set } = command.set;
        Object.assign(
          node!,
          Object.fromEntries(Object.entries(set).filter(([, value]) => value !== undefined)),
          at ? { x: at[0], y: at[1] } : {},
        );
        if (at) positioned.add(id);
        if ((set.label !== undefined || set.type !== undefined) && node!.sizing === 'auto')
          measured.add(id);
        touch(id);
        break;
      }
      case 'edge.update': {
        protect(id);
        if (!scene.edges[id]) fail('WRONG_ENTITY', 'Expected edge');
        Object.assign(
          scene.edges[id]!,
          Object.fromEntries(
            Object.entries(command.set).filter(([, value]) => value !== undefined),
          ),
        );
        touch(id);
        break;
      }
      case 'node.resize': {
        protect(id);
        if (!scene.nodes[id]) fail('WRONG_ENTITY', 'Expected node');
        Object.assign(
          scene.nodes[id]!,
          { width: command.width, height: command.height, sizing: 'fixed' },
          command.at ? { x: command.at[0], y: command.at[1] } : {},
        );
        positioned.add(id);
        touch(id);
        break;
      }
      case 'entity.lock': {
        const entity = protect(id, true);
        entity.locked = command.locked;
        touch(id);
        break;
      }
      case 'section.rename': {
        dependency(id);
        if (!scene.sections[id]) fail('WRONG_ENTITY', 'Expected section');
        scene.sections[id]!.title = command.title;
        touch(id);
        break;
      }
      case 'entity.delete': {
        protect(id);
        const incident = Object.values(scene.edges).filter(
          (edge) => edge.from === id || edge.to === id,
        );
        incident.forEach((edge) => protect(edge.id));
        for (const removedId of [id, ...incident.map((edge) => edge.id)]) {
          delete scene.nodes[removedId];
          delete scene.edges[removedId];
          tombstones.add(removedId);
          touch(removedId);
        }
        break;
      }
    }
    if (command.op.endsWith('.add')) additions.set(id, stable({ source: meta.source, command }));
  }

  if (equal(previous, scene)) return { state, manualIds: new Set(), diagnostics: [] };
  if (
    Object.keys(scene.nodes).length + Object.keys(scene.edges).length >
      context.limits.maxEntities ||
    Object.keys(scene.sections).length > context.limits.maxSections
  )
    fail('LIMIT', 'Document capacity exceeded');
  // Only the adapter sees provisional sizes; no partial state is published.
  const input = freeze({
    previousScene: structuredClone(previous),
    scene: freeze(scene),
    commands: structuredClone(commands),
    meta: structuredClone(meta),
    measureNodeIds: [...measured].filter((id) => !!scene.nodes[id]),
    addedNodeIds: [...added].filter((id) => !!scene.nodes[id]),
  });
  let output;
  try {
    output = validateLayout(context.layout.layoutTransaction(input));
  } catch (error) {
    throw new SceneError('LAYOUT', error instanceof Error ? error.message : String(error));
  }
  const next = structuredClone(scene);
  const allowed = new Set([...measured, ...positioned, ...added]);
  const affectedSections = new Set(
    commands.flatMap((command) => {
      const entity =
        scene.nodes[command.id] ??
        scene.edges[command.id] ??
        previous.nodes[command.id] ??
        previous.edges[command.id];
      return entity ? [entity.sectionId] : [];
    }),
  );
  for (const id of input.measureNodeIds)
    if (!Object.hasOwn(output.nodes, id)) fail('LAYOUT', `Missing measured geometry: ${id}`);
  for (const [id, geometry] of Object.entries(output.nodes)) {
    const node = next.nodes[id];
    const canRepair =
      meta.source === 'generated' &&
      node?.source === 'generated' &&
      !node.locked &&
      node.lastManualRevision === 0 &&
      !context.editingIds.has(id) &&
      affectedSections.has(node.sectionId) &&
      (measured.has(id) || (node.width === geometry.width && node.height === geometry.height));
    if (
      !node ||
      (!allowed.has(id) &&
        !canRepair &&
        !equal({ x: node.x, y: node.y, width: node.width, height: node.height }, geometry))
    )
      fail('LAYOUT', `Layout moved an unrelated node: ${id}`);
    if (Object.keys(geometry).some((key) => !['x', 'y', 'width', 'height'].includes(key)))
      fail('LAYOUT', 'Unexpected node layout fields');
    if (
      !added.has(id) &&
      !positioned.has(id) &&
      !canRepair &&
      (geometry.x !== node!.x || geometry.y !== node!.y)
    )
      fail('LAYOUT', 'Text sizing must preserve existing node position');
    if (
      node!.sizing === 'fixed' &&
      (geometry.width !== node!.width || geometry.height !== node!.height)
    )
      fail('LAYOUT', 'Layout cannot resize fixed nodes');
    Object.assign(node!, geometry);
  }
  for (const command of commands) {
    const at =
      command.op === 'node.update' ? command.set.at : 'at' in command ? command.at : undefined;
    if (meta.source !== 'manual' || !at || !next.nodes[command.id]) continue;
    // Multiple edits to the same node within a transaction use the final explicit position.
    const finalNode = scene.nodes[command.id]!;
    if (next.nodes[command.id]!.x !== finalNode.x || next.nodes[command.id]!.y !== finalNode.y)
      fail('LAYOUT', 'Manual placement must be respected');
  }
  if (Object.keys(output.sections).length !== Object.keys(next.sections).length)
    fail('LAYOUT', 'Layout must include every section');
  for (const [id, geometry] of Object.entries(output.sections)) {
    if (
      !next.sections[id] ||
      Object.keys(geometry).some((key) => !['origin', 'bounds'].includes(key))
    )
      fail('LAYOUT', 'Invalid section layout patch');
    Object.assign(next.sections[id]!, geometry);
  }
  next.revision = previous.revision + 1;
  for (const collection of ['nodes', 'edges'] as const) {
    for (const [id, entity] of Object.entries(next[collection])) {
      const old = previous[collection][id];
      if (!equal(old, entity)) {
        entity.revision = (old?.revision ?? 0) + 1;
        if (manualIds.has(id)) entity.lastManualRevision = next.revision;
      }
    }
  }
  const parsed = createSceneSchema(context.limits).safeParse(next);
  if (!parsed.success) fail('LAYOUT', parsed.error.message);
  return {
    state: { scene: parsed.data!, tombstones, additions },
    manualIds,
    diagnostics: output.diagnostics ?? [],
    ...(output.anchorDelta ? { anchorDelta: output.anchorDelta } : {}),
  };
}
