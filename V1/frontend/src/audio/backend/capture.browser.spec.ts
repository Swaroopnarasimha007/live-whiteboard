import { expect, test } from '@playwright/test';

test('production AudioWorklet captures synthetic 44.1/48 kHz audio and releases resources', async ({
  page,
}) => {
  await page.goto('/');
  const outcomes = await page.evaluate(async () => {
    const moduleUrl = '/src/audio/backend/browser.ts';
    const { browserAudioEnvironment } = (await import(moduleUrl)) as typeof import('./browser');
    const results = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const OriginalContext = window.AudioContext;
    for (const sampleRate of [44100, 48000]) {
      window.AudioContext = class extends OriginalContext {
        constructor(options?: AudioContextOptions) {
          super({ ...options, sampleRate });
        }
      };
      const context = new OriginalContext({ sampleRate });
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 1000;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      await context.resume();
      navigator.mediaDevices.getUserMedia = async () => destination.stream;
      const frames: ArrayBuffer[] = [];
      const errors: string[] = [];
      const controller = new AbortController();
      const capture = await browserAudioEnvironment().capture(
        (frame) => {
          frames.push(frame);
          capture.credit(frame.byteLength);
        },
        (code) => errors.push(code),
        100,
        2000,
        controller.signal,
      );
      // Wait for sample progress; browser scheduling does not guarantee real-time wall-clock pacing.
      const until = performance.now() + 5000;
      while (frames.length < 3 && performance.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 20));
      await capture.finish();
      results.push({
        frames: frames.map((frame) => frame.byteLength),
        errors,
        stopped: destination.stream.getTracks().every((track) => track.readyState === 'ended'),
      });
      oscillator.stop();
      await context.close();
    }
    navigator.mediaDevices.getUserMedia = original;
    window.AudioContext = OriginalContext;
    return results;
  });
  for (const result of outcomes) {
    expect(result.errors).toEqual([]);
    expect(result.stopped).toBe(true);
    expect(result.frames.length).toBeGreaterThanOrEqual(3);
    expect(result.frames.every((bytes) => bytes > 0 && bytes <= 3200 && bytes % 2 === 0)).toBe(
      true,
    );
  }
});
