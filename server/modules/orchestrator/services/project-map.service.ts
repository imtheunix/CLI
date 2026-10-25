import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCommand } from './workspace.service.js';

/** Used by jobs.service to prepare opt-in local maps and add bounded guidance for every backend. */
export async function prepareJobProjectMap(
  worktreePath: string,
  installation = path.join(os.homedir(), '.local/share/cli-graphify/current'),
): Promise<string> {
  const wrapper = path.join(installation, 'project-map.py');
  if (!existsSync(wrapper)) return '';
  try {
    // The same absolute shell interface is reachable by Claude, Codex and OpenCode.
    // This optional preparation never prevents a job from starting.
    const prepared = await runCommand('python3', ['-I', wrapper, 'prepare', '--repo', worktreePath], {
      cwd: worktreePath, timeoutMs: 60_000,
    });
    if (prepared.code !== 0) return '';
    const status = JSON.parse(prepared.stdout) as { state?: string };
    if (status.state === 'disabled') return '';
    const response = await runCommand('python3', ['-I', wrapper, 'guidance', '--repo', worktreePath], {
      cwd: worktreePath, timeoutMs: 15_000,
    });
    if (response.code !== 0) return '';
    const result = JSON.parse(response.stdout) as { guidance?: unknown };
    return typeof result.guidance === 'string' && result.guidance.length <= 12_000 ? result.guidance : '';
  } catch {
    return '';
  }
}
