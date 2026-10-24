import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Which `codex` binary the SDK should spawn.
 *
 * `@openai/codex-sdk` defaults to the binary bundled in its platform package,
 * which lags the system CLI: models served to ChatGPT accounts can be refused
 * by the bundled copy ("model is not supported when using Codex with a
 * ChatGPT account") while the system one accepts them. Order:
 *   1. CODEX_PATH, when set;
 *   2. the first `codex` on PATH outside a node_modules/.bin directory (npm
 *      scripts prepend the project's own, which runs the bundled version; a
 *      global npm install lives in node_modules too, but is found through its
 *      prefix's bin directory and is kept);
 *   3. undefined, so the SDK falls back to its bundled binary.
 */

export type CodexCliPathSource = 'env' | 'path' | 'bundled';

export type CodexCliPathResolution = {
  path: string | undefined;
  source: CodexCliPathSource;
};

export type ResolveCodexCliPathDependencies = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isExecutable?: (candidate: string) => boolean;
};

function defaultIsExecutable(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) {
      return false;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isNodeModulesBin(dir: string): boolean {
  const segments = dir.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) === '.bin' && segments.at(-2) === 'node_modules';
}

export function resolveCodexCliPath(dependencies: ResolveCodexCliPathDependencies = {}): CodexCliPathResolution {
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const isExecutable = dependencies.isExecutable ?? defaultIsExecutable;

  const configured = env.CODEX_PATH?.trim();
  if (configured) {
    return { path: configured, source: 'env' };
  }

  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const pathValue = (platform === 'win32' ? env.Path ?? env.PATH : env.PATH) ?? '';
  // The SDK spawns without a shell, so a Windows .cmd shim would not start.
  const names = platform === 'win32' ? ['codex.exe'] : ['codex'];

  for (const dir of pathValue.split(pathApi.delimiter)) {
    if (!dir || isNodeModulesBin(dir)) {
      continue;
    }
    for (const name of names) {
      const candidate = pathApi.join(dir, name);
      if (isExecutable(candidate)) {
        return { path: candidate, source: 'path' };
      }
    }
  }

  return { path: undefined, source: 'bundled' };
}

function readCodexVersion(binary: string | undefined): string {
  if (!binary) {
    return 'bundled with @openai/codex-sdk';
  }
  try {
    return execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    }).trim() || 'unknown version';
  } catch {
    return 'version unavailable';
  }
}

let cachedResolution: CodexCliPathResolution | null = null;

/**
 * The resolved binary for this server process, resolved and logged once.
 * Returns the value to pass as `codexPathOverride` (undefined = SDK bundled).
 */
export function getCodexPathOverride(): string | undefined {
  if (!cachedResolution) {
    cachedResolution = resolveCodexCliPath();
    const where = cachedResolution.path ?? 'SDK bundled binary';
    console.info(`[Codex] Using ${where} (${cachedResolution.source}): ${readCodexVersion(cachedResolution.path)}`);
  }
  return cachedResolution.path;
}
