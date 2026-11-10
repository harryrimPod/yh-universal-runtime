import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  // Relative asset URLs, so the built pages work from a sub-path of a hosting server too.
  base: './',
  build: {
    rollupOptions: {
      input: {
        dashboard: resolve(root, 'index.html'),
        threejs: resolve(root, 'examples/threejs/index.html'),
        babylonjs: resolve(root, 'examples/babylonjs/index.html'),
        verge3d: resolve(root, 'examples/verge3d/index.html')
      }
    }
  }
});
