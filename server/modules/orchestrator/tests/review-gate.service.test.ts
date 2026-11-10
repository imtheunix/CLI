import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { OrchestratorJobRow } from '@/modules/database/index.js';

import { runReviewGate } from '../services/review-gate.service.js';

test('review gate resolves configured checks, scopes oxlint, and runs changed and importing tests only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-gate-'));
  const repoPath = path.join(root, 'demo');
  const worktreePath = path.join(root, 'worktree');
  const job = { repo_path: repoPath, worktree_path: worktreePath } as OrchestratorJobRow;
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      scripts: {
        typecheck: 'tsc --noEmit',
        lint: 'oxlint .',
        test: 'tsx --tsconfig server/tsconfig.json --test "server/**/*.test.ts"',
      },
    }),
    'src/changed.ts': 'export const changed = true;\n',
    'src/changed.test.ts': 'import { changed } from "./changed.js";\n',
    'src/importing.test.ts': 'import { changed } from "./changed.js";\n',
    'src/unrelated.test.ts': 'import { untouched } from "./untouched.js";\n',
    'src/untouched.ts': 'export const untouched = true;\n',
  };

  try {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(worktreePath, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    const grepCalls: string[][] = [];
    const checkCalls: Array<{ args: string[]; cwd: string }> = [];
    const result = await runReviewGate(
      job,
      ['src/changed.ts', 'src/changed.test.ts'],
      { demo: 'npm run typecheck && npm run lint && npm test' },
      async (command, args, options) => {
        if (command === 'git') {
          grepCalls.push(args);
          return { code: 0, stdout: 'src/importing.test.ts\n', stderr: '' };
        }
        assert.equal(command, 'nice');
        assert.ok(options);
        checkCalls.push({ args, cwd: options.cwd });
        return { code: 0, stdout: 'gate passed', stderr: '' };
      },
    );

    assert.equal(grepCalls.length, 1, 'the changed test itself is not searched as a source module');
    assert.deepEqual(grepCalls[0].slice(0, 4), ['grep', '-l', '-F', 'changed']);
    assert.equal(checkCalls.length, 1);
    assert.equal(checkCalls[0].cwd, worktreePath);
    assert.deepEqual(checkCalls[0].args.slice(0, 4), ['-n', '10', '/bin/bash', '-lc']);
    assert.equal(
      checkCalls[0].args[4],
      "npm run typecheck && npx --no-install oxlint 'src/changed.ts' 'src/changed.test.ts' && npx --no-install tsx --tsconfig server/tsconfig.json --test 'src/changed.test.ts' 'src/importing.test.ts'",
    );
    assert.ok(!result.command.includes('unrelated.test.ts'));
    assert.ok(!result.command.includes('untouched.ts'));
    assert.equal(result.ok, true);
    assert.equal(result.output, 'gate passed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
