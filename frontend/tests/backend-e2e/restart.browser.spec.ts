import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('actual backend process restart keeps browser drawing and reconnect sends full context', async ({
  page,
}) => {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const backend = fileURLToPath(new URL('../../../backend/', import.meta.url));
  const python = path.join(
    backend,
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  let child: ChildProcess | undefined;
  const stop = async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  };
  const start = async () => {
    child = spawn(python, ['-m', 'app'], {
      cwd: backend,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        WHITEBOARD__SERVER__PORT: String(port),
        WHITEBOARD__SERVER__ALLOWED_ORIGINS: '[http://127.0.0.1:4194]',
        WHITEBOARD__TRANSCRIPTION__DEFAULT_PROFILE: 'mock',
        WHITEBOARD__DIAGRAM__ACTIVE_PROFILE: 'mock',
      },
    });
    await expect
      .poll(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/health/ready`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
  };
  try {
    await start();
    await page.goto('/');
    const previous = await page.evaluate(async (url) => {
      const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
      await h.startHarness(undefined, url);
      h.runtime.loadFixture();
      await h.request('The database uses a cache', 'pre_restart');
      return {
        identity: h.runtime.backend.getSnapshot().identity!,
        scene: h.runtime.store.exportScene(),
      };
    }, `http://127.0.0.1:${port}`);
    await stop();
    await start();
    const after = await page.evaluate(async () => {
      const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
      const preserved = h.runtime.store.exportScene();
      const result = await h.request('The database uses a cache', 'post_restart');
      return {
        preserved,
        request: h.lastRequest,
        result,
        identity: h.runtime.backend.getSnapshot().identity!,
      };
    });
    expect(after.preserved).toBe(previous.scene);
    expect(after.identity.sessionId).not.toBe(previous.identity.sessionId);
    expect(after.request.board.nodes.map((node: { id: string }) => node.id).sort()).toEqual(
      Object.keys(JSON.parse(previous.scene).nodes).sort(),
    );
    expect(after.request.board.contextComplete).toBe(true);
    expect(after.result.phase).toBe('completed');
  } finally {
    await stop();
  }
});
