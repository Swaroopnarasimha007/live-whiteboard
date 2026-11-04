import { defineConfig } from 'vite';

/** Build the B1 adapter independently while the application awaits B3 live-mode composition. */
export default defineConfig({
  build: {
    outDir: 'node_modules/.cache/whiteboard-b1-audio-build',
    emptyOutDir: false,
    lib: { entry: 'src/audio/backend/source.ts', formats: ['es'], fileName: 'backend-audio' },
  },
});
