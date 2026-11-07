import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const serverDir = fileURLToPath(new URL('./server', import.meta.url));
const srcDir = fileURLToPath(new URL('./src', import.meta.url));
const evalsDir = fileURLToPath(new URL('./evals', import.meta.url));

// The client test suite runs under jsdom because the hook and component tests
// added alongside the state refactor rely on real effects, DOM events and
// localStorage — none of which run under react-dom/server.
export default defineConfig({
  plugins: [
    {
      name: 'alias-server-modules',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer || (!importer.includes('/server/') && !importer.includes('/evals/'))) {
          return null;
        }
        let subpath: string | null = null;
        if (source.startsWith('@/')) {
          subpath = source.slice(2);
        } else if (source.startsWith(srcDir)) {
          subpath = source.slice(srcDir.length + 1);
        }
        if (!subpath) return null;

        const absPath = path.resolve(serverDir, subpath);
        const tsPath = absPath.replace(/\.js$/, '.ts');
        if (existsSync(tsPath)) return tsPath;
        const tsxPath = absPath.replace(/\.js$/, '.tsx');
        if (existsSync(tsxPath)) return tsxPath;
        if (existsSync(absPath)) return absPath;
        const indexTs = path.join(absPath, 'index.ts');
        if (existsSync(indexTs)) return indexTs;
        return absPath;
      },
    },
  ],
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    environment: 'jsdom',
    // Pinned so the suite does not silently change shape with a developer's
    // local .env — this workspace has VITE_IS_PLATFORM=true, CI has no .env at
    // all, and the flag decides whether the app authenticates with a bearer
    // token. The tests that care stub it per case and assert both modes.
    env: {
      VITE_IS_PLATFORM: 'false',
    },
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'evals/**/*.test.ts'],
    restoreMocks: true,
  },
});
