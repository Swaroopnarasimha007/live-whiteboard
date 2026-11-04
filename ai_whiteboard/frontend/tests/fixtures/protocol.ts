import { operationSchema, type Operation, type Scene } from '../../src/contracts';
export const protocolFixture: Operation[] = [
  { op: 'section.add', id: 'flow', title: 'Request flow' },
  {
    op: 'edge.add',
    id: 'request',
    section: 'flow',
    from: 'browser',
    to: 'server',
    label: 'Request',
  },
  { op: 'node.add', id: 'browser', section: 'flow', type: 'rect', label: 'Browser', at: [0, 0] },
  {
    op: 'node.add',
    id: 'server',
    section: 'flow',
    type: 'roundRect',
    label: 'Server',
    place: { rightOf: 'browser' },
  },
  {
    op: 'node.add',
    id: 'cache',
    section: 'flow',
    type: 'circle',
    label: 'Cache',
    place: { below: 'browser' },
  },
  {
    op: 'node.add',
    id: 'database',
    section: 'flow',
    type: 'ellipse',
    label: 'Database',
    place: { below: 'server' },
  },
  {
    op: 'node.add',
    id: 'decision',
    section: 'flow',
    type: 'diamond',
    label: 'Cached?',
    place: { below: 'cache' },
  },
  {
    op: 'node.add',
    id: 'note',
    section: 'flow',
    type: 'text',
    label: 'café 系统 🌍\nA second line',
    place: { below: 'database' },
  },
  { op: 'edge.add', id: 'query', section: 'flow', from: 'server', to: 'database', label: 'Query' },
  { op: 'edge.add', id: 'branch', section: 'flow', from: 'cache', to: 'decision', kind: 'line' },
  { op: 'node.update', id: 'server', set: { label: 'API server' } },
  { op: 'node.add', id: 'browser', section: 'flow', type: 'rect', label: 'Browser', at: [0, 0] },
  { op: 'section.add', id: 'next', title: 'Explicit next topic' },
  { op: 'node.add', id: 'unicode', section: 'next', type: 'rect', label: '第二个主题' },
].map((operation) => operationSchema.parse(operation));

/** Dense fixed geometry for reproducible performance workloads, never a model context shortcut. */
export function performanceScene(count: number, sectionCount: number): Scene {
  const scene: Scene = {
    schemaVersion: 1,
    documentId: 'performance',
    revision: 1,
    nodes: {},
    edges: {},
    sections: {},
  };
  const perSection = Math.ceil(count / sectionCount);
  for (let index = 0; index < count; index++) {
    const section = Math.floor(index / perSection);
    const sectionId = `g_s${section}`;
    const local = index % perSection;
    scene.sections[sectionId] ??= {
      id: sectionId,
      title: `Section ${section + 1}`,
      order: section,
      origin: { x: 0, y: section * 1800 },
      bounds: {
        x: -32,
        y: -74,
        width: 25 * 136 + 64,
        height: Math.ceil(perSection / 25) * 88 + 106,
      },
    };
    const id = `g_n${index}`;
    scene.nodes[id] = {
      id,
      sectionId,
      type: 'rect',
      label: `Node ${index}`,
      color: 'blue',
      source: 'generated',
      locked: false,
      revision: 1,
      lastManualRevision: 0,
      sizing: 'fixed',
      x: (local % 25) * 136,
      y: Math.floor(local / 25) * 88,
      width: 120,
      height: 64,
    };
  }
  return scene;
}
