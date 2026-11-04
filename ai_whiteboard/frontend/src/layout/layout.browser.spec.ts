import { expect, test } from '@playwright/test';

test('repairs growing labels and routes bidirectional arrows using real font metrics', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const layout = (await load('/src/layout/index.ts')) as typeof import('./index');
    const collisions = (await load('/src/layout/collisions.ts')) as typeof import('./collisions');
    const { createSceneStore } = (await load(
      '/src/scene/store.ts',
    )) as typeof import('../scene/store');
    await layout.prepareLayoutFonts();
    const store = createSceneStore({
      documentId: 'collision-browser',
      layout: layout.createLayoutEngine(),
    });
    const status = store.dispatchTransaction(
      [
        { op: 'section.add', id: 'g_s', title: 'Request and response' },
        {
          op: 'node.add',
          id: 'g_a',
          section: 'g_s',
          type: 'roundRect',
          label: 'Client',
          at: [0, 0],
        },
        { op: 'node.add', id: 'g_b', section: 'g_s', type: 'rect', label: 'API', at: [180, 0] },
        {
          op: 'node.add',
          id: 'g_c',
          section: 'g_s',
          type: 'ellipse',
          label: 'Database',
          at: [480, 0],
        },
        { op: 'edge.add', id: 'g_e1', section: 'g_s', from: 'g_a', to: 'g_c', label: 'Request' },
        {
          op: 'edge.add',
          id: 'g_e2',
          section: 'g_s',
          from: 'g_c',
          to: 'g_a',
          label: 'JSON response',
        },
        {
          op: 'edge.add',
          id: 'g_e3',
          section: 'g_s',
          from: 'g_a',
          to: 'g_b',
          label: 'Authentication',
        },
      ],
      {
        source: 'generated',
        requestId: 'r1',
        sequence: 0,
        baseRevision: 0,
        sessionEpoch: 0,
        transactionId: 'first',
      },
    ).status;
    const update = store.dispatch(
      {
        op: 'node.update',
        id: 'g_a',
        set: { label: 'Browser client with a significantly longer readable label' },
      },
      {
        source: 'generated',
        requestId: 'r2',
        sequence: 0,
        baseRevision: store.getSnapshot().revision,
        sessionEpoch: 0,
        transactionId: 'second',
      },
    );
    const board = store.getSnapshot();
    const nodes = Object.values(board.nodes);
    const nodeCollisions = nodes.flatMap((a, i) =>
      nodes.slice(i + 1).filter((b) => layout.boxesOverlap(a, b)),
    );
    const router = layout.createEdgeRouter();
    const routes = Object.values(board.edges).map((edge) => router.route(edge, board));
    let hits = 0;
    const origin = board.sections.g_s!.origin;
    for (const [routeIndex, route] of routes.entries()) {
      if (!route) {
        hits++;
        continue;
      }
      for (let i = 2; i < route.points.length; i += 2) {
        const a = { x: route.points[i - 2]! - origin.x, y: route.points[i - 1]! - origin.y };
        const b = { x: route.points[i]! - origin.x, y: route.points[i + 1]! - origin.y };
        const edge = Object.values(board.edges)[routeIndex]!;
        for (const n of nodes) {
          // Curved endpoints start on the actual shape, inside its conservative box.
          if (
            n.type !== 'rect' &&
            ((i === 2 && n.id === edge.from) || (i === route.points.length - 2 && n.id === edge.to))
          )
            continue;
          if (collisions.segmentHitsBox(a, b, n)) hits++;
        }
      }
    }
    store.dispose();
    return {
      status,
      update: update.status,
      nodeCollisions: nodeCollisions.length,
      hits,
      routes: routes.length,
    };
  });
  expect(result).toEqual({
    status: 'applied',
    update: 'applied',
    nodeCollisions: 0,
    hits: 0,
    routes: 3,
  });
});

test('real font metrics, canonical geometry and connector attachments agree in Chromium', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const layout = (await load('/src/layout/index.ts')) as typeof import('./index');
    const { createSceneStore } = (await load(
      '/src/scene/store.ts',
    )) as typeof import('../scene/store');
    await layout.prepareLayoutFonts();
    const engine = layout.createLayoutEngine();
    const store = createSceneStore({ documentId: 'browser-layout', layout: engine });
    const applied = store.dispatchTransaction(
      [
        { op: 'section.add', id: 'g_s', title: 'Browser metrics' },
        {
          op: 'node.add',
          id: 'g_a',
          section: 'g_s',
          type: 'diamond',
          label: 'Readable Unicode: café 系统',
        },
        {
          op: 'node.add',
          id: 'g_b',
          section: 'g_s',
          type: 'ellipse',
          label: 'API server',
          place: { rightOf: 'g_a' },
        },
        { op: 'edge.add', id: 'g_e', section: 'g_s', from: 'g_a', to: 'g_b', label: 'Request' },
      ],
      {
        source: 'generated',
        requestId: 'r1',
        sequence: 0,
        baseRevision: 0,
        sessionEpoch: 0,
        transactionId: 'tx',
      },
    );
    const scene = store.getSnapshot();
    const a = scene.nodes.g_a!;
    const b = scene.nodes.g_b!;
    const measured = layout.measureNode(a);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = `400 ${layout.FONT_SIZE}px ${layout.FONT_FAMILY}`;
    const fits = measured.text.lines.every(
      (line) => ctx.measureText(line).width <= measured.text.availableWidth + 0.01,
    );
    const routed = layout.routeEdge(scene.edges.g_e!, scene)!;
    const fromEquation =
      Math.abs((routed.start.x - a.x - a.width / 2) / (a.width / 2)) +
      Math.abs((routed.start.y - a.y - a.height / 2) / (a.height / 2));
    const toEquation =
      ((routed.end.x - b.x - b.width / 2) / (b.width / 2)) ** 2 +
      ((routed.end.y - b.y - b.height / 2) / (b.height / 2)) ** 2;
    const returned = {
      status: applied.status,
      estimated: measured.estimated,
      fits,
      truncated: measured.text.truncated,
      sameDimensions: a.width === measured.width && a.height === measured.height,
      gap: b.x - a.x - a.width,
      fromEquation,
      toEquation,
      diagnostics: store.getDiagnostics().length,
      labelBackground: routed.label!.background,
    };
    store.dispose();
    return returned;
  });
  expect(result.status).toBe('applied');
  expect(result.estimated).toBe(false);
  expect(result.fits).toBe(true);
  expect(result.truncated).toBe(false);
  expect(result.sameDimensions).toBe(true);
  expect(result.gap).toBe(64);
  expect(result.fromEquation).toBeCloseTo(1, 8);
  expect(result.toEquation).toBeCloseTo(1, 8);
  expect(result.diagnostics).toBe(0);
  expect(result.labelBackground).toBe('#ffffff');
});
