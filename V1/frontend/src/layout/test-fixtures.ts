import type { Edge, Node, Scene, Section } from '../contracts';
import type { TextMeasurer } from './text';

export const fixedMeasurer: TextMeasurer = {
  measure: (text, size = 16) => (Array.from(text).length * size) / 2,
};
export function node(overrides: Partial<Node> = {}): Node {
  return {
    id: 'g_a',
    sectionId: 'g_s',
    type: 'rect',
    label: 'Node',
    color: 'neutral',
    source: 'generated',
    locked: false,
    revision: 1,
    lastManualRevision: 0,
    sizing: 'auto',
    x: 0,
    y: 0,
    width: 120,
    height: 64,
    ...overrides,
  };
}
export function section(overrides: Partial<Section> = {}): Section {
  return {
    id: 'g_s',
    title: 'Section',
    order: 0,
    origin: { x: 0, y: 0 },
    bounds: { x: -32, y: -74, width: 320, height: 170 },
    ...overrides,
  };
}
export function edge(overrides: Partial<Edge> = {}): Edge {
  return {
    id: 'g_e',
    sectionId: 'g_s',
    from: 'g_a',
    to: 'g_b',
    kind: 'arrow',
    label: '',
    color: 'neutral',
    source: 'generated',
    locked: false,
    revision: 1,
    lastManualRevision: 0,
    ...overrides,
  };
}
export function scene(
  nodes: Node[] = [node(), node({ id: 'g_b', x: 300 })],
  sections: Section[] = [section()],
): Scene {
  return {
    schemaVersion: 1,
    documentId: 'layout-test',
    revision: 1,
    sections: Object.fromEntries(sections.map((s) => [s.id, s])),
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: {},
  };
}
