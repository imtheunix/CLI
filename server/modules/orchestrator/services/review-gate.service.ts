import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { OrchestratorJobRow } from '@/modules/database/index.js';

import { checkEnvironment, getCheckLogPath, resolveCheckCommand, runCommand } from './workspace.service.js';

const CHECK_TIMEOUT_MS = 20 * 60_000;
const TEST_PATTERNS = [':(glob)**/*.test.ts', ':(glob)**/*.test.tsx', ':(glob)**/*.test.js', ':(glob)**/*.test.jsx', ':(glob)**/test_*.py'];
const LINT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);

function shellQuote(file: string): string {
  return `'${file.replaceAll("'", "'\\''")}'`;
}

function isTestFile(file: string): boolean {
  return /(?:\.test\.[cm]?[jt]sx?|(?:^|\/)test_[^/]+\.py)$/.test(file);
}

async function relatedTests(job: OrchestratorJobRow, changedFiles: string[], run: typeof runCommand): Promise<string[]> {
  const found = new Set(changedFiles.filter((file) => isTestFile(file) && existsSync(path.join(job.worktree_path, file))));
  for (const file of changedFiles) {
    if (isTestFile(file) || !LINT_EXTENSIONS.has(path.extname(file))) continue;
    // Test imports name the source module; this also catches module-suite names such as orchestrator.test.ts.
    const token = path.basename(file).slice(0, -path.extname(file).length);
    const matches = await run('git', ['grep', '-l', '-F', token, '--', ...TEST_PATTERNS], { cwd: job.worktree_path });
    if (matches.code !== 0) continue;
    for (const match of matches.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) found.add(match);
  }
  return [...found].sort();
}

async function packageScripts(worktreePath: string): Promise<Record<string, string>> {
  try {
    const manifest = JSON.parse(await readFile(path.join(worktreePath, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return manifest.scripts ?? {};
  } catch {
    return {};
  }
}

function scopedLintCommand(part: string, files: string[], scripts: Record<string, string>): string | null {
  if (files.length === 0) return null;
  const args = files.map(shellQuote).join(' ');
  const npmScript = /^npm run (lint[\w:-]*)\b/.exec(part)?.[1];
  const script = npmScript ? scripts[npmScript] ?? '' : part;
  if (/\boxlint\b/.test(script)) return `npx --no-install oxlint ${args}`;
  if (/\beslint\b/.test(script)) return `npx --no-install eslint ${args}`;
  if (/\bruff\b/.test(script) || /\bruff\b/.test(part)) return `python -m ruff check ${args}`;
  if (npmScript) return `npm run ${npmScript} -- ${args}`;
  if (/\bruff check\b/.test(part)) return `python -m ruff check ${args}`;
  return `${part} ${args}`;
}

function testCommand(testFiles: string[], original: string | null, scripts: Record<string, string>): string {
  const args = testFiles.map(shellQuote).join(' ');
  const script = scripts.test ?? original ?? '';
  if (/\bvitest\b/.test(script)) return `npx --no-install vitest run ${args}`;
  if (/\btsx\b/.test(script) && testFiles.every((file) => /\.[cm]?[jt]sx?$/.test(file))) {
    const tsconfig = script.includes('--tsconfig server/tsconfig.json') ? ' --tsconfig server/tsconfig.json' : '';
    return `npx --no-install tsx${tsconfig} --test ${args}`;
  }
  if (/\bpytest\b/.test(script) || testFiles.every((file) => file.endsWith('.py'))) return `python -m pytest -q ${args}`;
  if (scripts.test || original?.includes('npm test')) return `npm test -- ${args}`;
  return original ? `${original} ${args}` : `node --test ${args}`;
}

/** Automatic review: the merge queue's configured checks, narrowed to changed source and their importing tests. */
export async function runReviewGate(
  job: OrchestratorJobRow,
  changedFiles: string[],
  configuredChecks: Record<string, string>,
  run: typeof runCommand,
): Promise<{ ok: boolean; command: string; output: string; logPath: string }> {
  const resolved = await resolveCheckCommand(job.repo_path, job.worktree_path, configuredChecks);
  const scripts = await packageScripts(job.worktree_path);
  const originalParts = resolved?.split(/\s*&&\s*/).map((part) => part.trim()).filter(Boolean) ?? [];
  const lintFiles = changedFiles.filter((file) => LINT_EXTENSIONS.has(path.extname(file)) && existsSync(path.join(job.worktree_path, file)));
  const testFiles = await relatedTests(job, changedFiles, run);
  const originalTest = originalParts.find((part) => /\b(?:test|pytest|vitest)\b/.test(part) && !/typecheck|test-compile/.test(part)) ?? null;
  const commands: string[] = [];
  for (const part of originalParts) {
    if (part === originalTest) continue;
    if (/\blint\b|\bruff check\b/.test(part)) {
      const scoped = scopedLintCommand(part, lintFiles, scripts);
      if (scoped) commands.push(scoped);
    } else {
      // Typecheck/compile stays project-aware: standalone file arguments would discard tsconfig and path aliases.
      commands.push(part);
    }
  }
  if (testFiles.length > 0) commands.push(testCommand(testFiles, originalTest, scripts));
  const command = commands.join(' && ');
  const logPath = getCheckLogPath(job.worktree_path);
  if (!command) return { ok: true, command: '(no applicable checks)', output: '', logPath };
  const result = await run('nice', ['-n', '10', '/bin/bash', '-lc', command], {
    cwd: job.worktree_path,
    timeoutMs: CHECK_TIMEOUT_MS,
    env: checkEnvironment(),
    logPath,
  });
  return {
    ok: result.code === 0 && !result.timedOut && !result.signal,
    command,
    output: `${result.stdout}\n${result.stderr}`.trim(),
    logPath,
  };
}
