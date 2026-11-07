import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';

test('denied hold microphone is actionable and mock demo stays available', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
    await h.startHarness(undefined, true);
  });
  await page.getByRole('button', { name: 'Hold to talk', exact: true }).focus();
  await page.keyboard.down('Space');
  await expect(page.getByTestId('capture-state')).toHaveAttribute('data-state', 'error');
  await page.keyboard.up('Space');
  await expect(page.getByText(/Microphone permission was denied/).first()).toBeVisible();
  await page.getByRole('combobox', { name: 'Input mode' }).selectOption('mock');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByTestId('capture-state')).toHaveAttribute('data-state', 'recording');
});

test('hold control cancels capture on Escape and focus loss, and supports pointer release outside', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
    await h.startHarness();
  });
  const hold = page.getByRole('button', { name: 'Hold to talk', exact: true });
  const captures = () =>
    page.evaluate(async () => {
      const h = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
      return h.activeCaptures;
    });
  await hold.focus();
  await page.keyboard.down('Space');
  await expect.poll(captures).toBe(1);
  await page.keyboard.press('Escape');
  await page.keyboard.up('Space');
  await expect.poll(captures).toBe(0);
  await expect(hold).toHaveAttribute('aria-pressed', 'false');
  await hold.focus();
  await page.keyboard.down('Space');
  await expect.poll(captures).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.keyboard.up('Space');
  await expect.poll(captures).toBe(0);
  const box = (await hold.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(captures).toBe(1);
  await page.mouse.move(10, 400);
  await page.mouse.up();
  await expect.poll(captures).toBe(0);
  await expect(hold).toHaveAttribute('aria-pressed', 'false');
});

test('Whisper short hold waits for release, applies final speech and closes capture', async ({
  page,
}) => {
  test.skip(
    !existsSync('../backed/backend/models/faster-whisper-small/model.bin') ||
      !existsSync('../backed/backend/models/synthetic-smoke.wav'),
    'Install Whisper Small and the local synthetic PCM fixture for this acceptance test',
  );
  const wav = readFileSync('../backed/backend/models/synthetic-smoke.wav');
  const data = wav.indexOf(Buffer.from('data'));
  const pcm = [...wav.subarray(data + 8, data + 8 + wav.readUInt32LE(data + 4))];
  await page.goto('/');
  await page.evaluate(async (bytes) => {
    const h = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
    await h.startHarness(bytes);
  }, pcm);
  await page.getByLabel('Speech profile').selectOption('whisper-small');
  const hold = page.getByRole('button', { name: 'Hold to talk', exact: true });
  await hold.focus();
  await page.keyboard.down('Space');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const h = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
        return h.capturedSamples;
      }),
    )
    .toBe(pcm.length / 2);
  expect(
    await page.evaluate(async () => {
      const h = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
      return h.runtime.session.getSnapshot().inspector;
    }),
  ).toBeNull();
  await page.keyboard.up('Space');
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const h = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
          return h.runtime.session
            .getSnapshot()
            .transcript.map((e: { text: string }) => e.text)
            .join(' ');
        }),
      { timeout: 30000 },
    )
    .toContain('server');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const h = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
        return {
          captures: h.activeCaptures,
          capture: h.runtime.session.getSnapshot().capture,
          hasNodes: Object.keys(h.runtime.store.getSnapshot().nodes).length > 0,
        };
      }),
    )
    .toMatchObject({ captures: 0, capture: 'idle', hasNodes: true });
});

test('Whisper long hold updates the board before release and flushes the remaining chunk', async ({
  page,
}) => {
  test.setTimeout(60000);
  test.skip(
    !existsSync('../backed/backend/models/faster-whisper-small/model.bin') ||
      !existsSync('../backed/backend/models/synthetic-smoke.wav'),
    'Install Whisper Small and the local synthetic PCM fixture for this acceptance test',
  );
  const wav = readFileSync('../backed/backend/models/synthetic-smoke.wav');
  const data = wav.indexOf(Buffer.from('data'));
  const once = wav.subarray(data + 8, data + 8 + wav.readUInt32LE(data + 4));
  const pcm = [...Buffer.concat([once, once, once])];
  await page.goto('/');
  await page.evaluate(async (bytes) => {
    const h = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
    await h.startHarness(bytes);
  }, pcm);
  await page.getByLabel('Speech profile').selectOption('whisper-small');
  const hold = page.getByRole('button', { name: 'Hold to talk', exact: true });
  await hold.focus();
  await page.keyboard.down('Space');
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const h = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
          return Object.keys(h.runtime.store.getSnapshot().nodes).length;
        }),
      { timeout: 30000 },
    )
    .toBeGreaterThan(0);
  await expect(hold).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.up('Space');
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const h = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
          const s = h.runtime.session.getSnapshot();
          return { capture: s.capture, chunks: s.transcript.length };
        }),
      { timeout: 30000 },
    )
    .toMatchObject({ capture: 'idle', chunks: 2 });
});
test('mock PCM crosses real audio and generation routes into the existing canvas; reset releases capture', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const harness = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
    await harness.startHarness();
  });
  await page.getByRole('combobox', { name: 'Input mode' }).selectOption('backend');
  await expect(page.getByLabel('Speech profile')).toBeVisible();
  const hold = page.getByRole('button', { name: 'Hold to talk', exact: true });
  await hold.focus();
  await page.keyboard.down('Space');
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const h = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
        return (Object.values(h.runtime.store.getSnapshot().nodes) as { label: string }[]).map(
          (n) => n.label,
        );
      }),
    )
    .toContain('Database');
  await page.keyboard.up('Space');
  await expect(hold).toHaveAttribute('aria-pressed', 'false');
  const snapshot = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
    return {
      observed: h.observed,
      session: h.runtime.session.getSnapshot(),
      backend: h.runtime.backend.getSnapshot(),
    };
  });
  expect(
    snapshot.observed.some(
      (s: { nodes: number; inFlight: boolean; phase: string }) =>
        s.nodes > 0 && s.inFlight && s.phase !== 'completed',
    ),
  ).toBe(true);
  expect(snapshot.session.inspector.request.sessionId).toMatch(/^bs_/);
  expect(snapshot.backend.identity.profile).toBe('mock');
  await expect(page.getByRole('application', { name: 'Whiteboard canvas' })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reset session', exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const h = await import(/* @vite-ignore */ '/src/session/backend/' + 'browserHarness.ts');
        return {
          epoch: h.runtime.store.getSessionEpoch(),
          nodes: Object.keys(h.runtime.store.getSnapshot().nodes).length,
          captures: h.activeCaptures,
        };
      }),
    )
    .toEqual({ epoch: 1, nodes: 0, captures: 0 });
});
