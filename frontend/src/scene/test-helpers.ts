import type { CommandMeta, SceneLayout } from '../contracts';
import { createSceneStore } from './store';

/** Test-only geometry, deliberately NOT exported from the package or usable as production layout. */
export const testLayout: SceneLayout = {
  layoutTransaction({ scene, commands, measureNodeIds, addedNodeIds }) {
    const nodes: ReturnType<SceneLayout['layoutTransaction']>['nodes'] = {};
    for (const id of measureNodeIds) {
      const node = scene.nodes[id]!;
      const width = Math.max(80, Math.min(1_900, node.label.length * 8 + 24));
      nodes[id] = { x: node.x, y: node.y, width, height: node.type === 'circle' ? width : 48 };
    }
    for (const id of addedNodeIds) {
      const command = commands.find((c) => c.id === id && c.op === 'node.add');
      if (command?.op !== 'node.add') continue;
      const geometry = nodes[id]!;
      if (command.place) {
        const anchorId = Object.values(command.place)[0] as string;
        const anchor = { ...scene.nodes[anchorId]!, ...nodes[anchorId] };
        geometry.x = anchor.x;
        geometry.y = anchor.y;
        if ('rightOf' in command.place) geometry.x += anchor.width + 64;
        if ('leftOf' in command.place) geometry.x -= geometry.width + 64;
        if ('below' in command.place) geometry.y += anchor.height + 64;
        if ('above' in command.place) geometry.y -= geometry.height + 64;
      }
    }
    const sections: ReturnType<SceneLayout['layoutTransaction']>['sections'] = {};
    let y = 0;
    for (const section of Object.values(scene.sections).sort((a, b) => a.order - b.order)) {
      sections[section.id] = {
        origin: { x: 0, y },
        bounds: { x: -32, y: -64, width: 800, height: 500 },
      };
      y += 660;
    }
    return { nodes, sections };
  },
};
export function setup(overrides: Partial<Parameters<typeof createSceneStore>[0]> = {}) {
  const store = createSceneStore({ documentId: 'test-document', layout: testLayout, ...overrides });
  let sequence = 0;
  let manualSequence = 0;
  const generated = (
    baseRevision = store.getSnapshot().revision,
    requestId = 'r1',
  ): CommandMeta => {
    sequence++;
    return {
      source: 'generated',
      requestId,
      sequence,
      baseRevision,
      sessionEpoch: store.getSessionEpoch(),
      transactionId: `g_tx_${sequence}`,
    };
  };
  const manual = (): CommandMeta => ({
    source: 'manual',
    sessionEpoch: store.getSessionEpoch(),
    transactionId: `m_tx_${++manualSequence}`,
  });
  const addSection = (id = 'g_s') =>
    store.dispatch({ op: 'section.add', id, title: 'Section' }, generated());
  const addNode = (id = 'g_n', section = 'g_s') =>
    store.dispatch({ op: 'node.add', id, section, type: 'rect', label: id }, generated());
  return { store, generated, manual, addSection, addNode };
}
export const manualNodeId = 'm_00000000-0000-4000-8000-000000000001';
export const manualSectionId = 'm_00000000-0000-4000-8000-000000000002';
