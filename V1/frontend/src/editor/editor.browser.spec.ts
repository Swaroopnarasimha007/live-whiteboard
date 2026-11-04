import { expect, test, type Page } from '@playwright/test';
import type { Scene } from '../contracts';
const errors = new WeakMap<Page, string[]>();
const canvas = (page: Page) => page.getByRole('application', { name: 'Editor harness canvas' });
async function harness(page: Page, count = 2, allShapes = false) {
  await page.evaluate(
    async ({ count, allShapes }) => {
      const m = await import(/* @vite-ignore */ '/src/editor/' + 'browserHarness.ts');
      await m.startHarness(count, allShapes);
    },
    { count, allShapes },
  );
  await expect(canvas(page).locator('canvas')).toHaveCount(3);
  await expect(canvas(page)).toHaveAttribute('data-last-drawn-revision', '1');
}
async function nodeRect(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
    );
    const group = h.board.current.getNodeRef(id);
    const rect = group.getClientRect({ skipStroke: true });
    const host = h.board.current.getStage().container().getBoundingClientRect();
    return { x: host.left + rect.x, y: host.top + rect.y, width: rect.width, height: rect.height };
  }, id);
}
async function clickNode(page: Page, id: string, shift = false) {
  const box = await nodeRect(page, id);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  if (shift) await page.keyboard.up('Shift');
}
async function graph(page: Page): Promise<Scene> {
  return page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
    );
    return h.store.getSnapshot();
  });
}
async function resizeHandle(page: Page, anchor = 'bottom-right') {
  return page.evaluate(async (anchor) => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
    );
    const stage = h.board.current.getStage();
    const handle = stage.findOne('.editor-transformer').findOne(`.${anchor}`);
    const p = handle.getAbsolutePosition();
    const box = stage.container().getBoundingClientRect();
    return { x: box.left + p.x, y: box.top + p.y };
  }, anchor);
}
test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', (e) => messages.push(e.message));
  await page.goto('/');
  await expect(
    page.getByRole('application', { name: 'Whiteboard canvas' }).locator('canvas'),
  ).toHaveCount(3);
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

test('all six shapes insert from the real palette and text saves through the DOM overlay', async ({
  page,
}) => {
  const board = page.getByRole('application', { name: 'Whiteboard canvas' });
  const rect = (await board.boundingBox())!;
  const labels = ['rectangle', 'rounded rectangle', 'circle', 'ellipse', 'diamond', 'text'];
  for (let index = 0; index < labels.length; index++) {
    await page.getByRole('button', { name: `Add ${labels[index]}`, exact: true }).click();
    await page.mouse.click(
      rect.x + 150 + (index % 3) * 240,
      rect.y + 120 + Math.floor(index / 3) * 220,
    );
    if (labels[index] === 'text') {
      await page.getByRole('textbox', { name: 'Edit object label' }).fill('Text note');
      await page.keyboard.press('Control+Enter');
    }
  }
  await expect(board).toHaveAttribute('data-visible-nodes', '6');
  await expect(board).toHaveAttribute('data-scene-revision', '7');
  const revision = await board.getAttribute('data-scene-revision');
  await page.getByRole('checkbox', { name: 'Snap', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Grid', exact: true }).check();
  await expect(board).toHaveAttribute('data-scene-revision', revision!);
});

for (const scale of [0.5, 2])
  test(`drag at ${scale * 100}% previews without committing, updates arrows and commits once`, async ({
    page,
  }) => {
    await harness(page);
    await page.evaluate(async (scale) => {
      const { activeHarness: h } = await import(
        /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
      );
      h.viewport.setViewport({ x: 100, y: 150, scale });
    }, scale);
    await expect(canvas(page)).toHaveAttribute('data-viewport-scale', String(scale));
    const draws = Number(await canvas(page).getAttribute('data-draw-count'));
    await page.evaluate(async () => {
      const { activeHarness: h } = await import(
        /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
      );
      h.board.current.getStage().draw();
    });
    await expect
      .poll(async () => Number(await canvas(page).getAttribute('data-draw-count')))
      .toBeGreaterThan(draws);
    await clickNode(page, 'g_n0');
    const box = await nodeRect(page, 'g_n0');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40, { steps: 6 });
    const preview = await page.evaluate(async () => {
      const { activeHarness: h } = await import(
        /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
      );
      const s = h.store.getSnapshot();
      return {
        revision: s.revision,
        x: s.nodes.g_n0!.x,
        preview: h.editor.getSnapshot().previews.g_n0,
        inProgress: h.editor.getSnapshot().interactionInProgress,
      };
    });
    expect(preview.revision).toBe(1);
    expect(preview.x).toBe(0);
    expect(preview.preview.x).toBeCloseTo(-60 / scale);
    expect(preview.inProgress).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { activeHarness: h } = await import(
            /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
          );
          return h.board.current.getStage().findOne('#g_e').findOne('Arrow').points()[0];
        }),
      )
      .toBeLessThan(120);
    await page.mouse.up();
    await expect(canvas(page)).toHaveAttribute('data-scene-revision', '2');
    expect((await graph(page)).nodes.g_n0!.x).toBeCloseTo(-60 / scale);
    await expect(page.getByRole('textbox', { name: 'Edit object label' })).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(canvas(page)).toHaveAttribute('data-scene-revision', '3');
    expect((await graph(page)).nodes.g_n0!.x).toBe(0);
    await page.keyboard.press('Control+Shift+z');
    expect((await graph(page)).nodes.g_n0!.x).toBeCloseTo(-60 / scale);
  });

test('native Transformer resizing commits dimensions and resets transient scales', async ({
  page,
}) => {
  await harness(page);
  await clickNode(page, 'g_n0');
  const handle = await resizeHandle(page);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 80, handle.y + 50, { steps: 8 });
  const during = await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
    );
    return {
      node: h.store.getSnapshot().nodes.g_n0,
      preview: h.editor.getSnapshot().previews.g_n0,
      progress: h.editor.getSnapshot().interactionInProgress,
    };
  });
  expect(during.node.width).toBe(120);
  expect(during.preview.width).toBeGreaterThan(150);
  expect(during.progress).toBe(true);
  await page.mouse.up();
  await expect(canvas(page)).toHaveAttribute('data-scene-revision', '2');
  const after = await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
    );
    return {
      node: h.store.getSnapshot().nodes.g_n0,
      scaleX: h.board.current.getNodeRef('g_n0').scaleX(),
      scaleY: h.board.current.getNodeRef('g_n0').scaleY(),
    };
  });
  expect(after.node.width).toBeCloseTo(during.preview.width);
  expect(after.node.height).toBeCloseTo(during.preview.height);
  expect(after.node.sizing).toBe('fixed');
  expect(after.scaleX).toBe(1);
  expect(after.scaleY).toBe(1);
});

test('Escape cancels a native resize and later mouse movement cannot leave a scaled ghost', async ({
  page,
}) => {
  await harness(page);
  await clickNode(page, 'g_n0');
  const handle = await resizeHandle(page);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 70, handle.y + 40, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.move(handle.x + 120, handle.y + 90);
  await page.mouse.up();
  const current = await graph(page);
  expect(current.revision).toBe(1);
  expect(current.nodes.g_n0!.width).toBe(120);
  const scale = await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
    );
    return h.board.current.getNodeRef('g_n0').scaleX();
  });
  expect(scale).toBe(1);
});

test('circle resizing preserves equal dimensions and properties enforce lock/unlock', async ({
  page,
}) => {
  await harness(page, 6, true);
  await clickNode(page, 'g_n2');
  const handle = await resizeHandle(page);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 60, handle.y + 30, { steps: 5 });
  await page.mouse.up();
  const circle = (await graph(page)).nodes.g_n2!;
  expect(circle.width).toBeCloseTo(circle.height);
  expect(circle.width).toBeGreaterThan(88);
  await page.getByRole('button', { name: 'Lock selection', exact: true }).click();
  const revision = (await graph(page)).revision;
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Edit label', exact: true })).toBeDisabled();
  await canvas(page).focus();
  await page.keyboard.press('Delete');
  expect((await graph(page)).revision).toBe(revision);
  await page.getByRole('button', { name: 'Unlock selection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
  await page.getByRole('spinbutton', { name: 'Object diameter' }).fill('48');
  await page.getByRole('button', { name: 'Apply size' }).click();
  expect((await graph(page)).nodes.g_n2!.width).toBe(48);
});

test('Shift selection duplicates internal edges and delete/undo preserves the original graph', async ({
  page,
}) => {
  await harness(page);
  await clickNode(page, 'g_n0');
  await clickNode(page, 'g_n1', true);
  await page.keyboard.press('Control+d');
  const duplicated = await graph(page);
  expect(Object.keys(duplicated.nodes)).toHaveLength(4);
  expect(Object.keys(duplicated.edges)).toHaveLength(2);
  const copies = Object.values(duplicated.nodes).filter((n) => n.source === 'manual');
  const copiedEdge = Object.values(duplicated.edges).find((e) => e.source === 'manual')!;
  expect(copies.map((n) => n.id)).toContain(copiedEdge.from);
  expect(copies.map((n) => n.id)).toContain(copiedEdge.to);
  await page.keyboard.press('Delete');
  expect(Object.keys((await graph(page)).nodes)).toHaveLength(2);
  await page.keyboard.press('Control+z');
  expect(Object.keys((await graph(page)).nodes)).toHaveLength(4);
});

test('connector tools preview, cancel and create arrows/plain lines by endpoint IDs', async ({
  page,
}) => {
  const palette = page.getByRole('complementary', { name: 'Editor harness properties' });
  await harness(page);
  await palette.getByRole('button', { name: 'Add arrow', exact: true }).click();
  await clickNode(page, 'g_n0');
  const b = await nodeRect(page, 'g_n1');
  await page.mouse.move(b.x, b.y - 30);
  await expect(canvas(page).locator('canvas')).toHaveCount(3);
  expect(Object.keys((await graph(page)).edges)).toHaveLength(1);
  await page.keyboard.press('Escape');
  await palette.getByRole('button', { name: 'Add line', exact: true }).click();
  await clickNode(page, 'g_n0');
  await clickNode(page, 'g_n1');
  const lines = Object.values((await graph(page)).edges).filter((e) => e.source === 'manual');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ kind: 'line', from: 'g_n0', to: 'g_n1' });
});

test('label overlay respects composition and typing shortcuts; stale generation cannot overwrite it', async ({
  page,
}) => {
  await harness(page);
  await clickNode(page, 'g_n0');
  await page.keyboard.press('Enter');
  const input = page.getByRole('textbox', { name: 'Edit object label' });
  await input.fill('Manual label');
  const protectedResult = await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
    );
    return h.store.dispatch(
      { op: 'node.update', id: 'g_n0', set: { label: 'Generated overwrite' } },
      {
        source: 'generated',
        requestId: 'concurrent',
        sequence: 0,
        baseRevision: 1,
        sessionEpoch: 0,
        transactionId: 'concurrent0',
      },
    );
  });
  expect(protectedResult).toMatchObject({ code: 'ACTIVE_EDIT' });
  await input.evaluate((el) =>
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'あ' })),
  );
  await page.keyboard.press('Enter');
  await expect(input).toBeVisible();
  expect((await graph(page)).revision).toBe(1);
  await input.evaluate((el) =>
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'あ' })),
  );
  await input.fill('Manual label');
  await page.keyboard.press('Control+Enter');
  await expect(input).toHaveCount(0);
  expect((await graph(page)).nodes.g_n0!.label).toBe('Manual label');
  const stale = await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
    );
    return h.store.dispatch(
      { op: 'node.update', id: 'g_n0', set: { label: 'Stale' } },
      {
        source: 'generated',
        requestId: 'concurrent',
        sequence: 1,
        baseRevision: 1,
        sessionEpoch: 0,
        transactionId: 'concurrent1',
      },
    );
  });
  expect(stale).toMatchObject({ code: 'STALE_MANUAL_EDIT' });
  await page.getByRole('button', { name: 'Edit label', exact: true }).click();
  await input.fill('Do not save');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  expect(Object.keys((await graph(page)).nodes)).toHaveLength(2);
  await page.keyboard.press('Escape');
  expect((await graph(page)).nodes.g_n0!.label).toBe('Manual label');
});

test('a palette item can be dragged onto the canvas at its actual drop position', async ({
  page,
}) => {
  await harness(page);
  const host = canvas(page);
  const rect = (await host.boundingBox())!;
  await page
    .getByRole('complementary', { name: 'Editor harness properties' })
    .getByRole('button', { name: 'Add rectangle', exact: true })
    .dragTo(host, { targetPosition: { x: 600, y: 400 } });
  await expect
    .poll(
      async () =>
        Object.values((await graph(page)).nodes).filter((n) => n.source === 'manual').length,
    )
    .toBe(1);
  const result = await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
    );
    const scene = h.store.getSnapshot() as import('../contracts').Scene;
    const n = Object.values(scene.nodes).find((n) => n.source === 'manual')!;
    return { node: n, viewport: h.viewport.getViewport() };
  });
  expect(result.node.x * result.viewport.scale + result.viewport.x).toBeCloseTo(600, 0);
  expect(result.node.y * result.viewport.scale + result.viewport.y).toBeCloseTo(400, 0);
  expect(rect.width).toBeGreaterThan(600);
});

test('group resizing commits every selected node in one transaction', async ({ page }) => {
  await harness(page);
  await clickNode(page, 'g_n0');
  await clickNode(page, 'g_n1', true);
  const handle = await resizeHandle(page);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 100, handle.y + 40, { steps: 6 });
  await page.mouse.up();
  const after = await graph(page);
  expect(after.revision).toBe(2);
  expect(after.nodes.g_n0!.width).toBeGreaterThan(120);
  expect(after.nodes.g_n1!.width).toBeCloseTo(after.nodes.g_n0!.width);
  expect(after.nodes.g_n1!.x).toBeGreaterThan(180);
  await page.keyboard.press('Control+z');
  const restored = await graph(page);
  expect(restored.nodes.g_n0!.width).toBe(120);
  expect(restored.nodes.g_n1!.x).toBe(180);
});

test('earlier-section reflow during a native resize preserves the preview under the pointer', async ({
  page,
}) => {
  await harness(page);
  await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
    );
    h.store.dispatchTransaction(
      [
        { op: 'section.add', id: 'g_later', title: 'Later section' },
        {
          op: 'node.add',
          id: 'g_later_node',
          section: 'g_later',
          type: 'rect',
          label: 'Resize me',
        },
      ],
      {
        source: 'generated',
        requestId: 'later',
        sequence: 0,
        baseRevision: 1,
        sessionEpoch: 0,
        transactionId: 'later0',
      },
    );
  });
  await expect(canvas(page)).toHaveAttribute('data-last-drawn-revision', '2');
  await clickNode(page, 'g_later_node');
  const handle = await resizeHandle(page, 'top-left');
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x - 40, handle.y - 30, { steps: 5 });
  const before = await nodeRect(page, 'g_later_node');
  await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/editor/' + 'browserHarness.ts'
    );
    h.store.dispatch(
      { op: 'node.update', id: 'g_n0', set: { at: [0, 800] } },
      {
        source: 'generated',
        requestId: 'upstream',
        sequence: 0,
        baseRevision: 2,
        sessionEpoch: 0,
        transactionId: 'upstream0',
      },
    );
  });
  await expect(canvas(page)).toHaveAttribute('data-last-drawn-revision', '3');
  const after = await nodeRect(page, 'g_later_node');
  expect(after.x).toBeCloseTo(before.x);
  expect(after.y).toBeCloseTo(before.y);
  expect(after.width).toBeCloseTo(before.width);
  await page.mouse.up();
  const node = (await graph(page)).nodes.g_later_node!;
  expect(node.sectionId).toBe('g_later');
  expect(node.x).toBeLessThan(0);
  expect(node.y).toBeLessThan(0);
  expect(node.width).toBeGreaterThan(120);
});
