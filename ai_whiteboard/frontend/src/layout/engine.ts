import {
  idSchema,
  layoutOutputSchema,
  type Box,
  type LayoutInput,
  type LayoutOutput,
  type Node,
  type SceneLayout,
} from '../contracts';
import { createEdgeRouter } from './edges';
import { repairNodeCollisions, spreadGeneratedSection } from './collisions';
import { boxesOverlap, resolvePlacement } from './placement';
import { getSectionOriginDeltas, layoutSections } from './sections';
import { getTextMeasurer, measureNode, type TextOptions } from './text';

export interface LayoutOptions extends TextOptions {
  anchorSectionId?: string | null;
  maxPlacementCandidates?: number;
  maxGeneratedRowWidth?: number;
}

export function layoutTransaction(input: LayoutInput, options: LayoutOptions = {}): LayoutOutput {
  return computeLayout(input, options);
}

function computeLayout(
  input: LayoutInput,
  options: LayoutOptions,
  router?: ReturnType<typeof createEdgeRouter>,
): LayoutOutput {
  const measurer = getTextMeasurer(options);
  const widthLimit = options.maxGeneratedRowWidth ?? 1000;
  if (!Number.isFinite(widthLimit) || widthLimit < 320)
    throw new Error('Generated row width must be at least 320');
  const geometry: LayoutOutput['nodes'] = {};
  const diagnostics: string[] = [];
  const added = new Set(input.addedNodeIds);
  const nodes: Record<string, Node> = {};
  for (const [id, node] of Object.entries(input.scene.nodes)) nodes[id] = { ...node };
  for (const id of input.measureNodeIds) {
    const node = nodes[id];
    if (!node) throw new Error(`Measurement target is missing: ${id}`);
    if (node.sizing === 'fixed') {
      geometry[id] = { x: node.x, y: node.y, width: node.width, height: node.height };
      continue;
    }
    const measurement = measureNode(node, { measurer });
    node.width = measurement.width;
    node.height = measurement.height;
    geometry[id] = { x: node.x, y: node.y, width: node.width, height: node.height };
    if (measurement.text.truncated)
      diagnostics.push(
        `Node ${id} text is clipped at the maximum automatic size; show its full label in the inspector`,
      );
  }
  const placed: Node[] = Object.values(nodes).filter((node) => !added.has(node.id));
  // First occurrence is the actual add; replayed adds and later node updates may also appear.
  for (const command of input.commands) {
    if (command.op !== 'node.add' || !added.has(command.id)) continue;
    const node = nodes[command.id];
    if (!node) continue;
    // A later explicit move in the same transaction overrides the initial add hint.
    const index = input.commands.indexOf(command);
    const later = input.commands.slice(index + 1).filter((c) => c.id === node.id);
    const explicitMove = later.some(
      (c) => (c.op === 'node.update' && c.set.at) || (c.op === 'node.resize' && c.at),
    );
    const at = explicitMove ? ([node.x, node.y] as const) : command.at;
    const place = explicitMove ? undefined : command.place;
    const rowWidth = options.maxGeneratedRowWidth ?? 1000;
    const anchor = place ? placed.find((n) => n.id === Object.values(place)[0]) : undefined;
    const wrap =
      input.meta.source === 'generated' &&
      !explicitMove &&
      place &&
      'rightOf' in place &&
      anchor &&
      anchor.x + anchor.width + 64 + node.width > rowWidth;
    const wrapAt = wrap
      ? ([
          0,
          Math.max(
            ...placed.filter((n) => n.sectionId === node.sectionId).map((n) => n.y + n.height),
            0,
          ) + 96,
        ] as const)
      : undefined;
    const result = resolvePlacement({
      node,
      nodes: placed,
      source: input.meta.source,
      ...(wrapAt ? { at: wrapAt } : at ? { at } : {}),
      ...(!wrapAt && place ? { place } : {}),
      ...(options.maxPlacementCandidates !== undefined
        ? { maxCandidates: options.maxPlacementCandidates }
        : {}),
    });
    node.x = result.x;
    node.y = result.y;
    geometry[node.id] = { x: node.x, y: node.y, width: node.width, height: node.height };
    diagnostics.push(...result.diagnostics);
    placed.push(node);
    added.delete(node.id);
  }
  if (added.size) throw new Error(`Added nodes lack commands: ${[...added].join(', ')}`);
  // Reflow overflow in affected sections only; manual edits remain authoritative.
  const affected = new Set(
    input.commands.flatMap((command) => {
      const n = nodes[command.id];
      const edge = input.scene.edges[command.id] ?? input.previousScene.edges[command.id];
      const previous = input.previousScene.nodes[command.id];
      return n ? [n.sectionId] : edge ? [edge.sectionId] : previous ? [previous.sectionId] : [];
    }),
  );
  if (input.meta.source === 'generated') {
    for (const node of Object.values(nodes)) {
      if (
        !affected.has(node.sectionId) ||
        node.source !== 'generated' ||
        node.locked ||
        node.lastManualRevision > 0 ||
        node.width > widthLimit ||
        node.x + node.width <= widthLimit
      )
        continue;
      const peers = Object.values(nodes).filter(
        (n) => n.sectionId === node.sectionId && n.id !== node.id,
      );
      const result = resolvePlacement({
        node,
        nodes: peers,
        source: 'generated',
        at: [0, Math.max(0, ...peers.map((n) => n.y + n.height)) + 96],
      });
      node.x = result.x;
      node.y = result.y;
      geometry[node.id] = { x: node.x, y: node.y, width: node.width, height: node.height };
    }
  }
  if (input.meta.source === 'generated') {
    const repaired = repairNodeCollisions(
      nodes,
      affected,
      new Set(input.commands.map((c) => c.id)),
      widthLimit,
    );
    for (const id of repaired) {
      const node = nodes[id]!;
      geometry[id] = { x: node.x, y: node.y, width: node.width, height: node.height };
      diagnostics.push(
        `Collision repaired for ${id}; corrected geometry committed to board context`,
      );
    }
  }
  for (const id of input.measureNodeIds) {
    const node = nodes[id]!;
    const old = input.previousScene.nodes[id];
    if (!old || (old.width === node.width && old.height === node.height)) continue;
    const overlap = Object.values(nodes).find(
      (other) => other.id !== id && other.sectionId === node.sectionId && boxesOverlap(node, other),
    );
    if (overlap)
      diagnostics.push(
        `Node ${id} overlaps ${overlap.id} after remeasurement; established positions preserved`,
      );
  }
  const sectionExtras = new Map<string, Box[]>();
  const routingScene = { nodes, sections: input.scene.sections, edges: input.scene.edges };
  const edgeRouter = router ?? createEdgeRouter({ measurer });
  if (input.meta.source === 'generated') {
    const failedSections = new Set(
      Object.values(input.scene.edges)
        .filter((edge) => affected.has(edge.sectionId) && !edgeRouter.route(edge, routingScene))
        .map((edge) => edge.sectionId),
    );
    for (const sectionId of failedSections) {
      for (const id of spreadGeneratedSection(nodes, sectionId, widthLimit)) {
        const node = nodes[id]!;
        geometry[id] = { x: node.x, y: node.y, width: node.width, height: node.height };
      }
      diagnostics.push(`Expanded generated spacing in ${sectionId} to recover connector routing`);
    }
  }
  for (const edge of Object.values(input.scene.edges)) {
    const route = edgeRouter.route(edge, routingScene);
    if (!route) {
      if (input.meta.source === 'generated' && affected.has(edge.sectionId))
        throw new Error(
          `No collision-free route/label placement for ${edge.id} within the routing budget`,
        );
      diagnostics.push(`No collision-free route/label placement for ${edge.id}`);
      continue;
    }
    diagnostics.push(...route.diagnostics);
    const origin = input.scene.sections[edge.sectionId]!.origin;
    const extras = sectionExtras.get(edge.sectionId) ?? [];
    const xs = route.points.filter((_, i) => i % 2 === 0);
    const ys = route.points.filter((_, i) => i % 2 === 1);
    extras.push({
      x: Math.min(...xs) - origin.x,
      y: Math.min(...ys) - origin.y,
      width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
      height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
    });
    sectionExtras.set(edge.sectionId, extras);
    if (!route.label) continue;
    extras.push({
      ...route.label.box,
      x: route.label.box.x - origin.x,
      y: route.label.box.y - origin.y,
    });
    sectionExtras.set(edge.sectionId, extras);
  }
  const sections = layoutSections(input.scene, Object.values(nodes), {
    measurer,
    previousSections: input.previousScene.sections,
    sectionExtras,
  });
  const deltas = getSectionOriginDeltas(input.previousScene, sections);
  const anchorDelta =
    options.anchorSectionId && Object.hasOwn(deltas, options.anchorSectionId)
      ? deltas[options.anchorSectionId]
      : undefined;
  if (measurer.estimated)
    diagnostics.push(
      'Estimated text metrics used; browser composition must prepare fonts and use canvas metrics',
    );
  const output: LayoutOutput = {
    nodes: geometry,
    sections,
    diagnostics,
    ...(anchorDelta ? { anchorDelta } : {}),
  };
  const parsed = layoutOutputSchema.safeParse(output);
  if (!parsed.success)
    throw new Error(
      `Layout exceeds representable scene geometry (including section padding/origins): ${parsed.error.message}`,
    );
  return output;
}

export function createLayoutEngine(
  options: LayoutOptions = {},
): SceneLayout & { setAnchorSection(id: string | null): void } {
  const measurer = getTextMeasurer(options);
  const router = createEdgeRouter({ measurer });
  let anchorSectionId =
    options.anchorSectionId == null ? null : idSchema.parse(options.anchorSectionId);
  return {
    layoutTransaction: (input) =>
      computeLayout(input, { ...options, measurer, anchorSectionId }, router),
    setAnchorSection: (id) => {
      anchorSectionId = id === null ? null : idSchema.parse(id);
    },
  };
}
