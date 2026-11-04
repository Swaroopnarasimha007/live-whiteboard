import { operationSchema, type GenerationRequest, type Operation } from '../contracts';

export const DEMO_SEGMENTS = Object.freeze({
  browser: 'demo-browser',
  server: 'demo-server',
  edge: 'demo-edge',
  correction: 'demo-correction',
  topic: 'demo-topic',
  database: 'demo-database',
  unicode: 'demo-unicode',
  disorder: 'demo-disorder',
});
/** Explicit segment IDs choose scenario operations; labels/timers never infer topic changes. */
export function buildDemoOperations(request: GenerationRequest): Operation[] {
  // Explicit fixture IDs may carry a unique utterance suffix for repeated demo runs.
  const segments = new Set(request.transcript.segmentIds.map((id) => id.split('__')[0]!));
  const tour = [...segments].find((id) => /^tour-(?:[1-4]|edit-1|add-2|edit-4)$/.test(id));
  if (tour) {
    const number =
      tour === 'tour-edit-1'
        ? 1
        : tour === 'tour-add-2'
          ? 2
          : tour === 'tour-edit-4'
            ? 4
            : Number(tour.at(-1));
    const title = `Segment ${number} · ${['Request', 'Data', 'Processing', 'Response'][number - 1]}`;
    const existing = request.board.sections.find((section) => section.title === title);
    const section = existing?.id ?? `${request.idPrefix}segment${number}`;
    const ops: unknown[] = existing ? [] : [{ op: 'section.add', id: section, title }];
    const nodes = request.board.nodes.filter((node) => node.sectionId === section);
    const labels = [
      ['Browser', 'API'],
      ['Cache', 'Database'],
      ['Queue', 'Worker'],
      ['Response', 'Metrics'],
    ][number - 1]!;
    const first = nodes.find((node) => node.label === labels[0])?.id ?? `${request.idPrefix}first`;
    const second =
      nodes.find((node) => node.label === labels[1])?.id ?? `${request.idPrefix}second`;
    if (!existing)
      ops.push(
        {
          op: 'node.add',
          id: first,
          section,
          type: 'rect',
          label: labels[0],
          color: 'blue',
          at: [0, 0],
        },
        {
          op: 'node.add',
          id: second,
          section,
          type: 'roundRect',
          label: labels[1],
          color: 'green',
          place: { rightOf: first },
        },
        {
          op: 'edge.add',
          id: `${request.idPrefix}link`,
          section,
          from: first,
          to: second,
          label: 'Flow',
        },
      );
    if (existing) {
      const target = nodes.find(
        (node) => node.label === (number === 1 ? 'API' : number === 4 ? 'Response' : 'Database'),
      );
      if (target && number !== 2)
        ops.push({
          op: 'node.update',
          id: target.id,
          set: {
            label: number === 1 ? 'Authenticated API' : 'Validated response',
            color: 'purple',
          },
        });
      const added = `${request.idPrefix}addition`;
      ops.push(
        {
          op: 'node.add',
          id: added,
          section,
          type: 'ellipse',
          label: number === 1 ? 'Authentication' : number === 2 ? 'Cache refresh' : 'Monitoring',
          color: 'orange',
          place: { below: nodes[0]!.id },
        },
        {
          op: 'edge.add',
          id: `${request.idPrefix}addition_link`,
          section,
          from: target?.id ?? nodes[0]!.id,
          to: added,
          label: number === 2 ? 'Refresh' : 'Check',
        },
      );
    }
    return ops.map((op) => operationSchema.parse(op));
  }
  if (![...Object.values(DEMO_SEGMENTS)].some((id) => segments.has(id))) return [];
  const operations: Operation[] = [];
  const add = (value: unknown) => {
    const op = operationSchema.parse(value);
    operations.push(op);
    return op;
  };
  const p = request.idPrefix;
  const unicode = segments.has(DEMO_SEGMENTS.unicode);
  let section = request.board.activeSectionId ?? request.board.sections.at(-1)?.id;
  if (segments.has(DEMO_SEGMENTS.topic) || !section) {
    section = `${p}topic`;
    add({
      op: 'section.add',
      id: section,
      title: segments.has(DEMO_SEGMENTS.topic) ? 'Next topic' : 'Request flow',
    });
  }
  const nodes = request.board.nodes.filter((n) => n.sectionId === section);
  const browser =
    nodes.find((n) => n.id.endsWith('_browser') || n.label === 'Browser')?.id ?? `${p}browser`;
  const server =
    nodes.find((n) => n.id.endsWith('_server') || ['Server', 'API server'].includes(n.label))?.id ??
    `${p}server`;
  const needsNodes = [...segments].some((id) => id !== DEMO_SEGMENTS.topic);
  if (needsNodes && !nodes.some((n) => n.id === browser))
    add({
      op: 'node.add',
      id: browser,
      section,
      type: 'rect',
      label: unicode ? 'Browser 系统' : 'Browser',
      color: 'blue',
      at: [0, 0],
    });
  const needsServer = [
    DEMO_SEGMENTS.server,
    DEMO_SEGMENTS.edge,
    DEMO_SEGMENTS.correction,
    DEMO_SEGMENTS.database,
    DEMO_SEGMENTS.disorder,
  ].some((id) => segments.has(id));
  if (needsServer && !nodes.some((n) => n.id === server))
    add({
      op: 'node.add',
      id: server,
      section,
      type: 'roundRect',
      label: unicode ? 'Server café' : 'Server',
      color: 'green',
      place: { rightOf: browser },
    });
  if (
    (segments.has(DEMO_SEGMENTS.edge) || segments.has(DEMO_SEGMENTS.disorder)) &&
    !request.board.edges.some((e) => e.from === browser && e.to === server)
  ) {
    const op = operationSchema.parse({
      op: 'edge.add',
      id: `${p}request`,
      section,
      from: browser,
      to: server,
      label: 'Request',
    });
    if (segments.has(DEMO_SEGMENTS.disorder))
      operations.splice(operations[0]?.op === 'section.add' ? 1 : 0, 0, op);
    else operations.push(op);
  }
  if (segments.has(DEMO_SEGMENTS.correction))
    add({ op: 'node.update', id: server, set: { label: 'API server' } });
  if (segments.has(DEMO_SEGMENTS.database)) {
    const database = nodes.find((n) => n.label === 'Database')?.id ?? `${p}database`;
    if (!nodes.some((n) => n.id === database))
      add({
        op: 'node.add',
        id: database,
        section,
        type: 'ellipse',
        label: 'Database',
        place: { below: server },
      });
    if (!request.board.edges.some((e) => e.from === server && e.to === database))
      add({
        op: 'edge.add',
        id: `${p}database_link`,
        section,
        from: server,
        to: database,
        label: 'Query',
      });
  }
  return operations;
}
