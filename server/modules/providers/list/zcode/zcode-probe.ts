import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ZcodeProbeOptions, ZcodeProbeResult } from '@/shared/types.js';

const PROBE_TTL_MS = 10 * 60_000;
let lastHealthyProbeAt = 0;
let lastSuccessfulTurnAt = 0;

/**
 * Checks whether a healthy ZCode probe or successful turn happened within the last 10 minutes.
 * Used by orchestrator dispatch and jobs service to avoid redundant probe executions.
 */
export function isZcodeProbeHealthy(now: Date = new Date()): boolean {
  const nowMs = now.getTime();
  return (nowMs - lastSuccessfulTurnAt < PROBE_TTL_MS) || (nowMs - lastHealthyProbeAt < PROBE_TTL_MS);
}

/**
 * Records that a successful ZCode turn completed, satisfying the 10-minute probe cache window.
 * Used by ZcodeProvider runtime and Orchestrator jobs service on turn completion.
 */
export function recordZcodeSuccess(time: Date = new Date()): void {
  lastSuccessfulTurnAt = time.getTime();
}

/**
 * Resets the cached probe and turn timestamps.
 * Used by tests to ensure a clean state between test runs.
 */
export function resetZcodeProbeCache(): void {
  lastHealthyProbeAt = 0;
  lastSuccessfulTurnAt = 0;
}

/**
 * Probes the ZCode CLI binary with a cheap headless command in a temp dir to check authentication.
 *
 * Runs `zcode -p "ok" --output-format stream-json --mode plan` with a 20 s timeout.
 * Returns { ok: true } on success, or { ok: false, error: 'login_failed', message } when
 * project_token_login_failed is encountered.
 * Under NODE_ENV=test, never runs the real binary unless options.explicit is true.
 *
 * Never reads or prints ~/.zcode/v2/credentials.json.
 * Used by Orchestrator jobs service to verify login before dispatching GLM/zcode turns.
 */
export async function probeZcodeLogin(options: ZcodeProbeOptions = {}): Promise<ZcodeProbeResult> {
  const now = options.now ?? new Date();
  if (isZcodeProbeHealthy(now)) {
    return { ok: true };
  }

  // Under test environment (NODE_ENV=test), never spawn the real zcode binary unless explicitly opted in.
  if (process.env.NODE_ENV === 'test' && !options.explicit) {
    return { ok: true };
  }

  const timeoutMs = options.timeoutMs ?? 20_000;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-probe-'));
  try {
    const { stdout, stderr, error } = await new Promise<{
      stdout: string;
      stderr: string;
      error?: Error & { killed?: boolean; code?: string | number | null };
    }>((resolve) => {
      execFile(
        'zcode',
        ['-p', 'ok', '--output-format', 'stream-json', '--mode', 'plan'],
        { cwd: tempDir, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (err, out, errOut) => {
          resolve({ stdout: String(out ?? ''), stderr: String(errOut ?? ''), error: err ?? undefined });
        },
      );
    });

    const combined = `${stdout}\n${stderr}\n${error?.message ?? ''}`;
    if (/project_token_login_failed/i.test(combined)) {
      lastHealthyProbeAt = 0;
      lastSuccessfulTurnAt = 0;
      const firstLine = combined.split('\n').map((l) => l.trim()).find((l) => /project_token_login_failed/i.test(l)) ?? 'project_token_login_failed';
      return { ok: false, error: 'login_failed', message: firstLine.slice(0, 200) };
    }

    if (error) {
      if (error.killed || error.code === 'ETIMEDOUT') {
        return { ok: false, error: 'timeout', message: `zcode probe timed out after ${timeoutMs}ms` };
      }
      return { ok: false, error: 'error', message: error.message };
    }

    lastHealthyProbeAt = now.getTime();
    return { ok: true };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
