import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';

for (const profile of ['whisper-small', 'whisper-medium']) {
  test(`real ${profile} WAV crosses browser WS transcript scheduler HTTP generation and canvas`, async ({
    page,
    browser,
  }, testInfo) => {
    test.skip(
      process.env.WHITEBOARD_MODEL_TESTS !== '1',
      'Opt-in local Whisper models + generated speech WAV required',
    );
    const wav = readFileSync(
      new URL('../../../benchmarks/backend/fixtures/technical-16k.wav', import.meta.url),
    );
    // resample.ts emits a canonical 44-byte PCM16 RIFF header through the production DSP path.
    expect(wav.readUInt32LE(24)).toBe(16000);
    const pcm = wav.subarray(44).toString('base64');
    await page.goto('/');
    await page.evaluate(async (input) => {
      const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
      await h.startHarness(input);
    }, pcm);
    await page.getByRole('combobox', { name: 'Input mode' }).selectOption('backend');
    const picker = page.getByLabel('Speech profile');
    await expect(
      picker.locator(`option[value="${profile}"]`),
      `${profile} must be available: install both models and preserve the speech extra with uv sync --project backend --locked --extra speech; ordinary uv run/sync without --extra speech can remove Whisper`,
    ).toBeEnabled();
    await picker.selectOption(profile);
    await expect(picker).toHaveValue(profile);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
          return h.runtime.backend.getSnapshot().profile;
        }),
      )
      .toBe(profile);
    await page.getByRole('button', { name: 'Hold to talk', exact: true }).focus();
    await page.keyboard.down('Space');
    await page.waitForTimeout(wav.length / 32 + 500);
    await page.keyboard.up('Space');
    await page.evaluate(async () => {
      const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
      h.mountMeasuredCanvas();
    });
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
            return Object.keys(h.runtime.store.getSnapshot().nodes).length;
          }),
        { timeout: 25_000 },
      )
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(async () => {
        const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
        return h.runtime.backend.getSnapshot().identity?.profile;
      }),
    ).toBe(profile);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
          return h.timing.firstNodeDrawMs;
        }),
      )
      .not.toBeNull();
    const measured = await page.evaluate(async () => {
      const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
      h.runtime.session.stop();
      return {
        ...h.timing,
        captureStartToFirstNodeKonvaDrawMs: h.timing.firstNodeDrawMs! - h.timing.captureStartMs,
        maxObservedTranscriptQueueAgeMs: Math.max(...h.timing.queueAgeMs),
      };
    });
    const report = {
      profile,
      measuredAt: new Date().toISOString(),
      browser: browser.version(),
      machine: {
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
        memoryGiB: os.totalmem() / 1024 ** 3,
        os: `${os.platform()} ${os.release()} ${os.arch()}`,
      },
      sampleRateHz: 16000,
      ...measured,
      clock: 'All spans use browser performance.now only',
      limitations:
        'One paced synthetic utterance per profile, mock diagram. First node uses actual Konva draw callback, not physical-screen timing. Frame-to-final includes network, queue and recognition; not a natural spoken-endpoint measurement. Capture starts after model load. Concurrent implementation chats and possible regression load present; diagnostic correctness run, not an isolated latency baseline.',
    };
    await writeFile(testInfo.outputPath(`speech-${profile}.json`), JSON.stringify(report, null, 2));
    await testInfo.attach(`speech-${profile}`, {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
          return h.activeCaptures;
        }),
      )
      .toBe(0);
  });
}
