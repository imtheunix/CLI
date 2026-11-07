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
  resolve: {
    alias: [
      {
        find: '@src',
        replacement: srcDir,
      },
      {
        find: '@server',
        replacement: serverDir,
      },
      {
        find: '@evals',
        replacement: evalsDir,
      },
      {
        find: /^@\/(.*)$/,
        replacement: '$1',
        customResolver(id, importer) {
          const isServerOrEval = importer && (importer.includes('/server/') || importer.includes('/evals/'));
          const basePath = isServerOrEval ? serverDir : srcDir;
          const target = path.resolve(basePath, id);
          const tsTarget = target.replace(/\.js$/, '.ts');
          if (existsSync(tsTarget)) return tsTarget;
          const tsxTarget = target.replace(/\.js$/, '.tsx');
          if (existsSync(tsxTarget)) return tsxTarget;
          if (existsSync(target)) return target;
          const indexTs = path.join(target, 'index.ts');
          if (existsSync(indexTs)) return indexTs;
          return target;
        },
      },
    ],
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
