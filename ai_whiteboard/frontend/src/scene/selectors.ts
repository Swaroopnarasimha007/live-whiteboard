import type { Edge, Node, Scene, Section } from '../contracts';

const own = <T>(records: Record<string, T>, id: string): T | undefined =>
  Object.hasOwn(records, id) ? records[id] : undefined;
export const selectNode = (scene: Scene, id: string) => own(scene.nodes, id);
export const selectEdge = (scene: Scene, id: string) => own(scene.edges, id);
export const selectSection = (scene: Scene, id: string) => own(scene.sections, id);
export const selectEntity = (scene: Scene, id: string) =>
  selectNode(scene, id) ?? selectEdge(scene, id) ?? selectSection(scene, id);
const sectionCache = new WeakMap<Scene['sections'], readonly Section[]>();
export function selectSections(scene: Scene): readonly Section[] {
  let result = sectionCache.get(scene.sections);
  if (!result) {
    result = Object.freeze(Object.values(scene.sections).sort((a, b) => a.order - b.order));
    sectionCache.set(scene.sections, result);
  }
  return result;
}
function sectionSelector<T extends Node | Edge>() {
  const cache = new WeakMap<Record<string, T>, Map<string, readonly T[]>>();
  return (records: Record<string, T>, sectionId: string): readonly T[] => {
    let bySection = cache.get(records);
    if (!bySection) {
      bySection = new Map();
      cache.set(records, bySection);
    }
    let result = bySection.get(sectionId);
    if (!result) {
      result = Object.freeze(
        Object.values(records).filter((entity) => entity.sectionId === sectionId),
      );
      bySection.set(sectionId, result);
    }
    return result;
  };
}
const nodesInSection = sectionSelector<Node>();
const edgesInSection = sectionSelector<Edge>();
export const selectSectionNodes = (scene: Scene, sectionId: string) =>
  nodesInSection(scene.nodes, sectionId);
export const selectSectionEdges = (scene: Scene, sectionId: string) =>
  edgesInSection(scene.edges, sectionId);

/** Use one selector per mounted section to retain list identity across unrelated section edits. */
function stableSectionSelector<T extends Node | Edge>(
  select: (scene: Scene, id: string) => readonly T[],
  id: string,
) {
  let previous: readonly T[] = Object.freeze([]);
  return (scene: Scene): readonly T[] => {
    const next = select(scene, id);
    if (previous.length !== next.length || next.some((entity, index) => entity !== previous[index]))
      previous = next;
    return previous;
  };
}
export const createSectionNodesSelector = (id: string) =>
  stableSectionSelector(selectSectionNodes, id);
export const createSectionEdgesSelector = (id: string) =>
  stableSectionSelector(selectSectionEdges, id);
