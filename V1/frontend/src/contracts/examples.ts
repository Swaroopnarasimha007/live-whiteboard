import type { Operation } from './schemas';

export const operationExamples: readonly Operation[] = [
  { op: 'section.add', id: 'g_r1_topic', title: 'Request flow' },
  {
    op: 'node.add',
    id: 'g_r1_browser',
    section: 'g_r1_topic',
    type: 'rect',
    label: 'Browser',
    color: 'blue',
    at: [0, 0],
  },
  {
    op: 'node.add',
    id: 'g_r1_server',
    section: 'g_r1_topic',
    type: 'roundRect',
    label: 'Server',
    color: 'neutral',
    place: { rightOf: 'g_r1_browser' },
  },
  {
    op: 'edge.add',
    id: 'g_r1_e1',
    section: 'g_r1_topic',
    from: 'g_r1_browser',
    to: 'g_r1_server',
    label: 'Request',
    color: 'neutral',
    kind: 'arrow',
  },
  { op: 'node.update', id: 'g_r1_server', set: { label: 'API server' } },
  { op: 'edge.update', id: 'g_r1_e1', set: { color: 'green' } },
  { op: 'entity.delete', id: 'g_r1_e1' },
];
export const invalidOperationExamples: readonly unknown[] = [
  { op: 'node.add', id: '__proto__', section: 'g_s', type: 'rect', label: 'Bad' },
  { op: 'node.add', id: 'g_bad', section: 'g_s', type: 'svg', label: 'Bad' },
  { op: 'node.update', id: 'g_n', set: { width: 99 } },
  { op: 'node.add', id: 'g_n', section: 'g_s', type: 'rect', label: 'Bad', at: [Infinity, 0] },
];
