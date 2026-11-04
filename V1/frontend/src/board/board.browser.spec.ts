import { expect, test, type Page } from '@playwright/test';
import type Konva from 'konva';

const board = (page: Page) => page.getByRole('application', { name: 'Whiteboard canvas' });
const pageErrors = new WeakMap<Page, string[]>();
async function camera(page: Page) {
  return board(page).evaluate((el) => ({
    x: Number(el.getAttribute('data-viewport-x')),
    y: Number(el.getAttribute('data-viewport-y')),
    scale: Number(el.getAttribute('data-viewport-scale')),
  }));
}
async function load(page: Page) {
  await page.getByText('Developer tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Load renderer fixture' }).click();
  await expect(board(page)).toHaveAttribute('data-scene-revision', '1');
  await expect(board(page)).toHaveAttribute('data-last-drawn-revision', '1');
}
async function fixtureControls(page: Page) {
  await page.getByText('Renderer fixture controls', { exact: true }).click();
}
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(board(page).locator('canvas')).toHaveCount(3);
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

test('renders all shapes in three layers; toggles grid without touching scene or viewport', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await load(page);
  await expect(board(page)).toHaveAttribute('data-visible-nodes', '6');
  await expect(board(page)).toHaveAttribute('data-visible-edges', '4');
  const before = await camera(page);
  const pixels = await board(page)
    .locator('canvas')
    .nth(1)
    .evaluate((canvas) => {
      const c = canvas as HTMLCanvasElement;
      const ctx = c.getContext('2d')!;
      return ctx
        .getImageData(0, 0, c.width, c.height)
        .data.some((value, i) => i % 4 === 3 && value !== 0);
    });
  expect(pixels).toBe(true);
  for (let i = 0; i < 4; i++) await page.getByRole('checkbox', { name: 'Grid' }).click();
  expect(await camera(page)).toEqual(before);
  await expect(board(page)).toHaveAttribute('data-scene-revision', '1');
  expect(errors).toEqual([]);
});

test('wheel zooms in both directions, Shift pans, and Space/hand/middle drags still pan', async ({
  page,
}) => {
  await load(page);
  const box = (await board(page).boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await board(page).evaluate((host) =>
    host.addEventListener(
      'wheel',
      (event) => {
        const wheel = event as WheelEvent;
        host.setAttribute('data-test-wheel', JSON.stringify({ x: wheel.deltaX, y: wheel.deltaY }));
      },
      { once: true, capture: true },
    ),
  );
  await page.mouse.move(point.x, point.y);
  const before = await camera(page);
  await page.mouse.wheel(30, 60);
  await expect(board(page)).toHaveAttribute('data-test-wheel', /./);
  const actualWheel = JSON.parse((await board(page).getAttribute('data-test-wheel'))!) as {
    x: number;
    y: number;
  };
  await expect.poll(async () => (await camera(page)).scale).toBeLessThan(before.scale);
  expect((await camera(page)).scale).toBeCloseTo(before.scale * Math.exp(-actualWheel.y * 0.002));
  await expect(board(page)).toHaveAttribute('data-follow-live', 'false');
  const zoomedOut = await camera(page);
  await board(page).dispatchEvent('wheel', {
    deltaX: 30,
    deltaY: 60,
    shiftKey: true,
    clientX: point.x,
    clientY: point.y,
  });
  await expect.poll(async () => (await camera(page)).y).toBe(zoomedOut.y - 60);
  expect((await camera(page)).x).toBe(zoomedOut.x - 30);
  expect((await camera(page)).scale).toBe(zoomedOut.scale);
  const pan = await camera(page);
  await board(page).evaluate((host) =>
    host.addEventListener(
      'wheel',
      (event) => {
        const wheel = event as WheelEvent;
        host.setAttribute(
          'data-test-zoom-pointer',
          JSON.stringify({ x: wheel.clientX, y: wheel.clientY }),
        );
      },
      { once: true, capture: true },
    ),
  );
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await camera(page)).scale).toBeGreaterThan(pan.scale);
  const actualPointer = JSON.parse((await board(page).getAttribute('data-test-zoom-pointer'))!) as {
    x: number;
    y: number;
  };
  const local = { x: actualPointer.x - box.x, y: actualPointer.y - box.y };
  const world = { x: (local.x - pan.x) / pan.scale, y: (local.y - pan.y) / pan.scale };
  const zoom = await camera(page);
  expect((local.x - zoom.x) / zoom.scale).toBeCloseTo(world.x, 4);
  expect((local.y - zoom.y) / zoom.scale).toBeCloseTo(world.y, 4);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await board(page).focus();
  await page.keyboard.down('Space');
  const held = await camera(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 70, point.y + 45);
  await page.mouse.up();
  await page.keyboard.up('Space');
  expect((await camera(page)).x).toBeCloseTo(held.x + 70);
  expect((await camera(page)).y).toBeCloseTo(held.y + 45);
  await page.getByRole('button', { name: 'Hand', exact: true }).click();
  const hand = await camera(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x - 40, point.y + 20);
  await page.mouse.up();
  expect((await camera(page)).x).toBeCloseTo(hand.x - 40);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const middle = await camera(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(point.x + 25, point.y + 10);
  await page.mouse.up({ button: 'middle' });
  expect((await camera(page)).x).toBeCloseTo(middle.x + 25);
  await expect(board(page)).toHaveAttribute('data-scene-revision', '1');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('new canvas objects fade quickly without changing geometry or hit testing, and do not replay after culling', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const samples = await page.evaluate(async () => {
    const harness = await import(/* @vite-ignore */ '/src/board/' + 'browserHarness.ts');
    harness.startHarness(2, false);
    const h = harness.activeHarness;
    const opacity: number[] = [];
    let hitWhileFading = false;
    await new Promise<void>((resolve) => {
      const sample = () => {
        const node = h.handle.current?.getNodeRef('g_n0');
        if (node) {
          opacity.push(node.opacity());
          const hit = h.handle.current!.getStage()!.getIntersection({ x: 60, y: 32 });
          if (node.opacity() < 1 && hit?.findAncestor('.board-node')?.id() === 'g_n0')
            hitWhileFading = true;
        }
        if (opacity.length < 20) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    const node = h.handle.current!.getNodeRef('g_n0')!;
    return {
      opacity,
      hitWhileFading,
      x: node.x(),
      y: node.y(),
      scaleX: node.scaleX(),
      scaleY: node.scaleY(),
      revision: h.scene.revision,
    };
  });
  expect(samples.opacity.some((value) => value < 1)).toBe(true);
  expect(samples.opacity.at(-1)).toBe(1);
  expect(samples.hitWhileFading).toBe(true);
  expect(samples).toMatchObject({ x: 0, y: 0, scaleX: 1, scaleY: 1, revision: 1 });
  await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/board/' + 'browserHarness.ts'
    );
    h.controller.setViewport({ x: -10000, y: -10000, scale: 1 });
  });
  const host = page.getByRole('application', { name: 'Harness board' });
  await expect(host).toHaveAttribute('data-visible-nodes', '0');
  const restoredOpacity = await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/board/' + 'browserHarness.ts'
    );
    h.controller.setViewport({ x: 0, y: 0, scale: 1 });
    return new Promise<number>((resolve) => {
      const sample = () => {
        const node = h.handle.current?.getNodeRef('g_n0');
        if (node) resolve(node.opacity());
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  });
  expect(restoredOpacity).toBe(1);
});

test('large imports bound concurrent fades and reduced motion skips them', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const large = await page.evaluate(async () => {
    const harness = await import(/* @vite-ignore */ '/src/board/' + 'browserHarness.ts');
    harness.startHarness(1000, false);
    const h = harness.activeHarness;
    h.controller.setViewport({ x: 0, y: 0, scale: 0.3 });
    return new Promise<{ visible: number; fading: number }>((resolve) => {
      const sample = () => {
        const nodes = h.handle.current?.getStage()?.find('.board-node');
        if (nodes?.length)
          resolve({
            visible: nodes.length,
            fading: nodes.filter((node: Konva.Node) => node.opacity() < 1).length,
          });
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  });
  expect(large.visible).toBeGreaterThan(48);
  expect(large.fading).toBeGreaterThan(0);
  expect(large.fading).toBeLessThanOrEqual(48);
  // Toggling the OS preference also finishes animations already in flight.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { activeHarness: h } = await import(
          /* @vite-ignore */ '/src/board/' + 'browserHarness.ts'
        );
        return h.handle
          .current!.getStage()!
          .find('.board-node')
          .filter((node: Konva.Node) => node.opacity() !== 1).length;
      }),
    )
    .toBe(0);
  const reducedOpacity = await page.evaluate(async () => {
    const harness = await import(/* @vite-ignore */ '/src/board/' + 'browserHarness.ts');
    harness.stopHarness();
    harness.startHarness(2, false);
    return new Promise<number>((resolve) => {
      const sample = () => {
        const node = harness.activeHarness.handle.current?.getNodeRef('g_n0');
        if (node) resolve(node.opacity());
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  });
  expect(reducedOpacity).toBe(1);
});

test('follow tracks latest generated section while manual browsing remains independent', async ({
  page,
}) => {
  await load(page);
  await fixtureControls(page);
  await page.getByRole('button', { name: 'Append topic', exact: true }).click();
  await expect(board(page)).toHaveAttribute('data-live-section', 'g_preview_r2_topic');
  const latest = await camera(page);
  await page.getByRole('button', { name: 'Request flow', exact: true }).click();
  const browsed = await camera(page);
  expect(browsed.y).not.toBe(latest.y);
  await page.getByRole('button', { name: 'Append topic', exact: true }).click();
  await expect(board(page)).toHaveAttribute('data-live-section', 'g_preview_r3_topic');
  expect(await camera(page)).toEqual(browsed);
  await page.getByRole('button', { name: 'Resume live', exact: true }).click();
  await expect(board(page)).toHaveAttribute('data-follow-live', 'true');
  expect((await camera(page)).y).not.toBe(browsed.y);
  const scale = (await camera(page)).scale;
  await page.getByRole('button', { name: 'Append distant fixture node' }).click();
  await expect(board(page)).toHaveAttribute('data-scene-revision', '4');
  expect((await camera(page)).scale).toBe(scale);
  expect((await camera(page)).x).toBeLessThan(-500);
});

test('resizing and growing earlier sections preserve the viewed section anchor', async ({
  page,
}) => {
  await load(page);
  await fixtureControls(page);
  await page.getByRole('button', { name: 'Append topic', exact: true }).click();
  await page.getByRole('button', { name: 'Topic 2', exact: true }).click();
  const before = await camera(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(async () => (await board(page).boundingBox())!.width).toBeGreaterThan(1_400);
  expect(await camera(page)).toEqual(before);
  await page.getByRole('button', { name: 'Grow first section' }).click();
  await expect(board(page)).toHaveAttribute('data-scene-revision', '3');
  const after = await camera(page);
  expect(after.y).toBeLessThan(before.y);
  expect(after.scale).toBe(before.scale);
  await expect(board(page)).toHaveAttribute('data-follow-live', 'false');
});

test('sidebar wheel scrolls the sidebar; text entry does not trigger Space navigation', async ({
  page,
}) => {
  await load(page);
  await fixtureControls(page);
  for (let i = 0; i < 8; i++)
    await page.getByRole('button', { name: 'Append topic', exact: true }).click();
  const aside = page.getByRole('complementary', { name: 'Board information' });
  const r = (await aside.boundingBox())!;
  const before = await camera(page);
  await page.mouse.move(r.x + r.width / 2, r.y + 50);
  await aside.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(() => aside.evaluate((el) => el.scrollTop)).toBe(0);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => aside.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await camera(page)).toEqual(before);
  await board(page).evaluate((host) => {
    const input = document.createElement('textarea');
    input.setAttribute('aria-label', 'Test text editor');
    input.style.cssText = 'position:absolute;left:20px;top:20px;z-index:10';
    host.appendChild(input);
  });
  const input = page.getByRole('textbox', { name: 'Test text editor' });
  await input.focus();
  await page.keyboard.type('a b');
  await expect(input).toHaveValue('a b');
  expect(await camera(page)).toEqual(before);
});

test('real two-finger touch pans and pinches without changing the scene', async ({
  page,
  context,
}) => {
  await load(page);
  const r = (await board(page).boundingBox())!;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const cdp = await context.newCDPSession(page);
  const before = await camera(page);
  const touches = (left: number, right: number, y: number) => [
    { x: left, y, id: 1 },
    { x: right, y, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: touches(cx - 70, cx + 70, cy),
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: touches(cx - 45, cx + 95, cy + 30),
  });
  await expect.poll(async () => (await camera(page)).x).toBeCloseTo(before.x + 25, 0);
  const panned = await camera(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: touches(cx - 100, cx + 150, cy + 30),
  });
  await expect.poll(async () => (await camera(page)).scale).toBeGreaterThan(panned.scale);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(board(page)).toHaveAttribute('data-follow-live', 'false');
  await expect(board(page)).toHaveAttribute('data-scene-revision', '1');
  for (let i = 0; i < 10; i++) {
    const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
    if (await zoomIn.isDisabled()) break;
    await zoomIn.click();
  }
  await expect(board(page)).toHaveAttribute('data-viewport-scale', '4');
  await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled();
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: touches(cx - 70, cx + 70, cy),
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: touches(cx - 95, cx + 45, cy + 30),
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(board(page)).toHaveAttribute('data-viewport-scale', '4');
});

test('window blur clears temporary Space pan and releases captured pointers', async ({ page }) => {
  await load(page);
  const r = (await board(page).boundingBox())!;
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  await board(page).focus();
  await page.keyboard.down('Space');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 20, y + 20);
  const before = await camera(page);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.move(x + 100, y + 100);
  await page.mouse.up();
  await page.keyboard.up('Space');
  expect(await camera(page)).toEqual(before);
  await expect(board(page)).toHaveCSS('cursor', 'default');
});

test('high-DPI hit testing works for every supported shape at 50% and 200% zoom', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const harness = await import(/* @vite-ignore */ '/src/board/' + 'browserHarness.ts');
    harness.startHarness();
  });
  const harnessBoard = page.getByRole('application', { name: 'Harness board' });
  await expect(harnessBoard.locator('canvas')).toHaveCount(3);
  for (const scale of [0.5, 2])
    for (let index = 0; index < 6; index++) {
      const id = `g_n${index}`;
      const drawCount = Number(await harnessBoard.getAttribute('data-draw-count'));
      await page.evaluate(
        async ({ id, scale }) => {
          const { activeHarness: h } = await import(
            /* @vite-ignore */ '/src/board/' + 'browserHarness.ts'
          );
          const n = h.scene.nodes[id];
          h.controller.setViewport({
            x: 400 - (n.x + n.width / 2) * scale,
            y: 300 - (n.y + n.height / 2) * scale,
            scale,
          });
        },
        { id, scale },
      );
      await expect(harnessBoard).toHaveAttribute('data-viewport-scale', String(scale));
      await expect
        .poll(async () => Number(await harnessBoard.getAttribute('data-draw-count')))
        .toBeGreaterThan(drawCount);
      await page.mouse.click(400, 300);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const { activeHarness } = await import(
              /* @vite-ignore */ '/src/board/' + 'browserHarness.ts'
            );
            return activeHarness.events.at(-1)?.id;
          }),
        )
        .toBe(id);
      const hit = await page.evaluate(async (id) => {
        const { activeHarness: h } = await import(
          /* @vite-ignore */ '/src/board/' + 'browserHarness.ts'
        );
        const n = h.scene.nodes[id];
        const event = h.events.at(-1);
        return {
          x: event.x,
          y: event.y,
          expectedX: n.x + n.width / 2,
          expectedY: n.y + n.height / 2,
        };
      }, id);
      expect(hit.x).toBeCloseTo(hit.expectedX);
      expect(hit.y).toBeCloseTo(hit.expectedY);
    }
  const ratio = await harnessBoard
    .locator('canvas')
    .nth(1)
    .evaluate(
      (el) => (el as HTMLCanvasElement).width / parseFloat((el as HTMLCanvasElement).style.width),
    );
  expect(ratio).toBe(2);
});

test('culls 5000 entities across 50 sections and cleans up refs, stages and observers on unmount', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const harness = await import(/* @vite-ignore */ '/src/board/' + 'browserHarness.ts');
    harness.startHarness(5_000, false);
  });
  const host = page.getByRole('application', { name: 'Harness board' });
  await expect(host.locator('canvas')).toHaveCount(3);
  await expect
    .poll(async () => Number(await host.getAttribute('data-visible-nodes')))
    .toBeLessThan(250);
  const before = await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/board/' + 'browserHarness.ts'
    );
    return {
      total: Object.keys(h.scene.nodes).length,
      layers: h.handle.current.getStage().getLayers().length,
    };
  });
  expect(before).toEqual({ total: 5_000, layers: 3 });
  await page.evaluate(async () => {
    const harness = await import(/* @vite-ignore */ '/src/board/' + 'browserHarness.ts');
    harness.stopHarness();
  });
  await expect(host).toHaveCount(0);
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect(board(page).locator('canvas')).toHaveCount(3);
});

test('transient node previews update connectors without mutating canonical geometry or revision', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const harness = await import(/* @vite-ignore */ '/src/board/' + 'browserHarness.ts');
    harness.startHarness(2, false);
  });
  const host = page.getByRole('application', { name: 'Harness board' });
  await expect(host.locator('canvas')).toHaveCount(3);
  await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/board/' + 'browserHarness.ts'
    );
    h.update({ previews: { g_n0: { x: -100, y: 0, width: 180, height: 64 } } });
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { activeHarness: h } = await import(
          /* @vite-ignore */ '/src/board/' + 'browserHarness.ts'
        );
        return h.handle.current.getStage().findOne('#g_e').findOne('Arrow').points()[0];
      }),
    )
    .toBe(80);
  const canonical = await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/board/' + 'browserHarness.ts'
    );
    return { x: h.scene.nodes.g_n0.x, width: h.scene.nodes.g_n0.width, revision: h.scene.revision };
  });
  expect(canonical).toEqual({ x: 0, width: 120, revision: 1 });
});

test('node refs retain identity and selection decoration does not distort transformer bounds', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const harness = await import(/* @vite-ignore */ '/src/board/' + 'browserHarness.ts');
    harness.startHarness(2, false);
  });
  const host = page.getByRole('application', { name: 'Harness board' });
  await expect(host.locator('canvas')).toHaveCount(3);
  await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/board/' + 'browserHarness.ts'
    );
    h.handle.current.getNodeRef('g_n0').setAttr('testIdentity', 42);
    h.update({
      selectedIds: ['g_n0'],
      scene: {
        ...h.scene,
        nodes: { ...h.scene.nodes, g_n1: { ...h.scene.nodes.g_n1, color: 'red', revision: 2 } },
        revision: 2,
      },
    });
  });
  await expect(host).toHaveAttribute('data-scene-revision', '2');
  const result = await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/board/' + 'browserHarness.ts'
    );
    const group = h.handle.current.getNodeRef('g_n0');
    const bounds = group.getClientRect({ skipTransform: true, skipStroke: true });
    return {
      identity: group.getAttr('testIdentity'),
      width: group.width(),
      boundsWidth: bounds.width,
      boundsHeight: bounds.height,
    };
  });
  expect(result).toEqual({ identity: 42, width: 120, boundsWidth: 120, boundsHeight: 64 });
});
