import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { orchestratorJobsDb, runningTurnsDb } from '@/modules/database/index.js';
import type { RunningTurnRow } from '@/modules/database/index.js';
import type { NormalizedMessage, ProviderRuntimeWriter } from '@/shared/types.js';

import {
  attachRelayedProcess,
  exitStatusCode,
  launchRelayUnit,
  readRelayExit,
} from '../relay/relay-process.js';

let cachedSystemdRunAvailable: boolean | null = null;
const fallbackProcesses = new Map<string, ChildProcess>();
/** Relayed units this server process drives itself (not reattached ones). */
const attachedUnits = new Set<string>();

const DETACHED_EXEC = fileURLToPath(new URL('../relay/detached-exec.js', import.meta.url));

export type DetachedTurnExecution = {
  unitName: string;
  logPath: string;
  isSystemd: boolean;
  promise: Promise<{ exitCode: number }>;
};

export type LineHandler = (line: string, writer?: ProviderRuntimeWriter, sessionId?: string | null) => void;

/** Line parsers registered per backend to parse stdout/stderr JSONL lines into stream messages. */
const backendLineParsers = new Map<string, LineHandler>();

/** Register a line parser for a backend so both live execution and reattachment parse identically. */
export function registerBackendLineParser(backend: string, handler: LineHandler): void {
  backendLineParsers.set(backend, handler);
}

/** Check if systemd-run is available on this system. Cached after first probe. */
export function isSystemdRunAvailable(forceProbe = false): boolean {
  if (process.env.CLI_DISABLE_SYSTEMD_RUN === '1') {
    return false;
  }
  if (process.platform !== 'linux') {
    return false;
  }
  if (!forceProbe && cachedSystemdRunAvailable !== null) {
    return cachedSystemdRunAvailable;
  }

  try {
    const probe = spawnSync('systemd-run', ['--user', '--unit=cli-turn-probe', '--collect', 'true'], {
      stdio: 'ignore',
      timeout: 2000,
    });
    cachedSystemdRunAvailable = probe.status === 0;
  } catch {
    cachedSystemdRunAvailable = false;
  }
  return cachedSystemdRunAvailable;
}

/** Reset systemd-run availability cache for tests. */
export function resetSystemdRunCache(): void {
  cachedSystemdRunAvailable = null;
}

/** Returns the directory where turn logs are placed. */
export function getTurnsDirectory(): string {
  return process.env.CLI_TURNS_DIR || path.join(os.homedir(), '.cache', 'cli', 'turns');
}

/** Generate a unit name for a transient systemd unit following cli-turn-<jobOrSession>-<n>. */
export function generateUnitName(jobOrSession: string): string {
  const safeId = (jobOrSession || 'turn').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32);
  const n = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  return `cli-turn-${safeId}-${n}`;
}

/** Return the log path for a turn's stdout and stderr. */
export function getTurnLogPath(unitName: string): string {
  return path.join(getTurnsDirectory(), `${unitName}.log`);
}

/** Checks whether a systemd user unit or fallback child process is currently active. */
export function isTurnAlive(unitName: string): boolean {
  const fallbackChild = fallbackProcesses.get(unitName);
  if (fallbackChild) {
    if (fallbackChild.exitCode !== null || fallbackChild.signalCode !== null || fallbackChild.pid === undefined) {
      return false;
    }
    try {
      process.kill(fallbackChild.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  if (isSystemdRunAvailable()) {
    try {
      const result = spawnSync('systemctl', ['--user', 'is-active', `${unitName}.service`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      const state = (result.stdout || '').trim();
      return state === 'active' || state === 'activating';
    } catch {
      return false;
    }
  }

  return false;
}

/** Retrieves exit code of a completed unit from systemd or process/log inspection. */
export function getUnitExitCode(unitName: string, logPath?: string): number {
  // A relayed turn records its CLI's own exit status.
  const relayStatus = readRelayExit(logPath || getTurnLogPath(unitName));
  if (relayStatus) {
    return exitStatusCode(relayStatus);
  }

  const fallbackChild = fallbackProcesses.get(unitName);
  if (fallbackChild) {
    if (fallbackChild.exitCode !== null) {
      return fallbackChild.exitCode;
    }
    if (fallbackChild.pid === undefined) {
      return 1;
    }
  }

  if (isSystemdRunAvailable()) {
    try {
      const result = spawnSync('systemctl', [
        '--user',
        'show',
        `${unitName}.service`,
        '-p', 'ExecMainStatus',
        '-p', 'ExecMainCode',
        '-p', 'Result',
        '-p', 'ActiveState',
        '-p', 'LoadState',
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      const props: Record<string, string> = {};
      for (const line of (result.stdout || '').split('\n')) {
        const [k, ...v] = line.split('=');
        if (k) props[k.trim()] = v.join('=').trim();
      }

      if (props.LoadState && props.LoadState !== 'not-found') {
        const statusCode = Number(props.ExecMainStatus);
        if (Number.isFinite(statusCode) && statusCode !== 0) {
          return statusCode;
        }
        if (props.ActiveState === 'failed' || (props.Result && props.Result !== 'success')) {
          return 1;
        }
        if (props.Result === 'success') {
          return 0;
        }
      }

      // If collected by systemd, query journalctl for unit's main process exit status
      const journalRes = spawnSync('journalctl', [
        '--user',
        '-u', `${unitName}.service`,
        '--no-pager',
        '-n', '10',
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });

      const journalText = journalRes.stdout || '';
      const match = /status=(\d+)/.exec(journalText);
      if (match) {
        const code = Number(match[1]);
        if (Number.isFinite(code)) {
          return code;
        }
      }
      if (/Failed with result/i.test(journalText)) {
        return 1;
      }
    } catch {
      // ignore systemctl/journalctl failure and check log below
    }
  }

  // Inspect the transcript/log if provided or at default turn log path
  const targetLog = logPath || getTurnLogPath(unitName);
  if (fs.existsSync(targetLog)) {
    try {
      const content = fs.readFileSync(targetLog, 'utf8');
      const lines = content.trim().split('\n');
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 15); i--) {
        const line = lines[i].trim();
        if (!line) continue;
        if (line.startsWith('{')) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (parsed.event === 'error' || parsed.kind === 'error') return 1;
            if (typeof parsed.result === 'object' && parsed.result !== null) {
              const res = parsed.result as Record<string, unknown>;
              if (res.status && res.status !== 'SUCCESS') return 1;
            }
          } catch {}
        }
        if (/error:|fatal|uncaught exception/i.test(line)) {
          return 1;
        }
      }
    } catch {}
  }

  return 0;
}

/**
 * Tails a log file until the process exits, emitting each complete line to onLine.
 * Performs a final drain upon termination.
 */
export async function tailLogFile(
  logPath: string,
  options: {
    isAlive: () => boolean;
    onLine: (line: string) => void;
    pollIntervalMs?: number;
    startOffset?: number;
  },
): Promise<number> {
  const pollInterval = options.pollIntervalMs ?? 50;
  let offset = options.startOffset ?? 0;
  let lineBuffer = '';

  const drain = () => {
    try {
      if (!fs.existsSync(logPath)) return;
      const stat = fs.statSync(logPath);
      if (stat.size <= offset) return;

      const fd = fs.openSync(logPath, 'r');
      const bytesToRead = stat.size - offset;
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, offset);
      fs.closeSync(fd);

      offset = stat.size;
      lineBuffer += buffer.toString('utf8');

      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          options.onLine(line);
        }
      }
    } catch {
      // transient read errors while writing
    }
  };

  while (options.isAlive()) {
    drain();
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Drain any remaining output after termination
  drain();
  if (lineBuffer.trim()) {
    options.onLine(lineBuffer.trim());
  }

  return offset;
}

/**
 * Spawns a detached agent turn in its own transient systemd unit (or direct spawn fallback).
 * Records the turn in the DB, redirects stdout/stderr to a per-turn log file,
 * and streams parsed lines to onLine.
 */
export function spawnDetachedTurn(input: {
  command: string;
  args: string[];
  cwd: string;
  sessionId: string;
  backend: string;
  jobId?: string | null;
  env?: Record<string, string>;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}): DetachedTurnExecution {
  const unitName = generateUnitName(input.jobId || input.sessionId);
  const logPath = getTurnLogPath(unitName);
  const turnsDir = path.dirname(logPath);
  fs.mkdirSync(turnsDir, { recursive: true });

  runningTurnsDb.recordTurn({
    unitName,
    jobId: input.jobId ?? null,
    sessionId: input.sessionId,
    backend: input.backend,
    logPath,
  });

  const mergedEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...(input.env || {}),
  };
  delete mergedEnv._;

  const useSystemd = isSystemdRunAvailable();
  let fallbackChild: ChildProcess | undefined;

  if (useSystemd) {
    const systemdArgs = [
      '--user',
      `--unit=${unitName}`,
      '--collect',
      `--working-directory=${input.cwd}`,
      `-pStandardOutput=file:${logPath}`,
      `-pStandardError=append:${logPath}`,
      // Below the default weight (100): the server, the hub and merge checks keep their share while agents build.
      '-pCPUWeight=50',
    ];

    for (const [key, val] of Object.entries(mergedEnv)) {
      if (typeof val === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && !val.includes('\n') && !val.includes('\r')) {
        systemdArgs.push(`--setenv=${key}=${val}`);
      }
    }

    systemdArgs.push('--', input.command, ...input.args);
    const spawnRes = spawnSync('systemd-run', systemdArgs, { stdio: 'ignore' });
    if (spawnRes.status !== 0) {
      console.warn(`[DetachedTurns] systemd-run failed with code ${spawnRes.status}; falling back to direct spawn`);
    }
  }

  let childError: Error | null = null;
  if (!useSystemd || !isTurnAlive(unitName)) {
    const fd = fs.openSync(logPath, 'a');
    fallbackChild = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: mergedEnv,
      stdio: ['ignore', fd, fd],
      detached: true,
    });
    fallbackChild.on('error', (err) => {
      childError = err;
      handleLine(JSON.stringify({ event: 'error', content: err.message, error: err.message }));
      try {
        fs.appendFileSync(logPath, `\nError: ${err.message}\n`);
      } catch {}
    });
    fallbackChild.unref();
    fallbackProcesses.set(unitName, fallbackChild);
    fs.closeSync(fd);
  }

  const parser = backendLineParsers.get(input.backend);
  const handleLine = (line: string) => {
    input.onLine?.(line);
    parser?.(line);
  };

  const promise = (async () => {
    let abortListener: (() => void) | undefined;
    if (input.signal) {
      abortListener = () => {
        abortTurn(input.sessionId);
      };
      input.signal.addEventListener('abort', abortListener, { once: true });
    }

    try {
      await tailLogFile(logPath, {
        isAlive: () => !childError && isTurnAlive(unitName),
        onLine: handleLine,
      });

      const exitCode = childError ? 1 : getUnitExitCode(unitName);
      runningTurnsDb.completeTurn(unitName, exitCode);
      fallbackProcesses.delete(unitName);
      return { exitCode };
    } finally {
      if (input.signal && abortListener) {
        input.signal.removeEventListener('abort', abortListener);
      }
    }
  })();

  return {
    unitName,
    logPath,
    isSystemd: useSystemd,
    promise,
  };
}

export type RelayedTurnProcess = ReturnType<typeof attachRelayedProcess>;

/**
 * Spawns a CLI that keeps stdin open across its turn (Claude's stream-json)
 * in a relayed systemd unit, recorded in running_turns so a restarted server
 * reattaches to it. Returns a ChildProcess-shaped handle, or null when
 * systemd-run is unavailable or the unit did not start: the caller then
 * spawns the CLI directly, as before.
 */
export function spawnRelayedTurn(input: {
  command: string;
  args: string[];
  cwd: string;
  sessionId: string;
  backend: string;
  jobId?: string | null;
  env?: Record<string, string | undefined>;
  protocol?: 'claude' | null;
  signal?: AbortSignal;
}): RelayedTurnProcess | null {
  if (!isSystemdRunAvailable()) {
    return null;
  }
  const unitName = generateUnitName(input.jobId || input.sessionId);
  const logPath = getTurnLogPath(unitName);
  runningTurnsDb.recordTurn({
    unitName,
    jobId: input.jobId ?? null,
    sessionId: input.sessionId,
    backend: input.backend,
    logPath,
  });

  const env: Record<string, string | undefined> = { ...process.env, ...(input.env || {}) };
  delete env._;
  const launched = launchRelayUnit({
    unitName,
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env,
    logPath,
    protocol: input.protocol ?? null,
  });
  if (!launched) {
    console.warn(`[DetachedTurns] systemd-run could not start ${unitName}; spawning ${input.backend} directly`);
    runningTurnsDb.deleteTurn(unitName);
    return null;
  }

  attachedUnits.add(unitName);
  const child = attachRelayedProcess({ unitName, logPath, signal: input.signal });
  child.once('exit', (code: number | null, signal: string | null) => {
    attachedUnits.delete(unitName);
    runningTurnsDb.completeTurn(unitName, exitStatusCode({ code, signal }));
  });
  return child;
}

/**
 * For an SDK that spawns its CLI itself (Codex): records a turn and returns
 * the wrapper executable and environment that make the SDK's child a relayed
 * unit. Null when systemd-run is unavailable: the SDK spawns the CLI directly.
 * `complete` is called once the SDK's run is over.
 */
export function prepareDetachedExec(input: {
  command: string | undefined;
  sessionId: string | null | undefined;
  backend: string;
  jobId?: string | null;
}): { executable: string; env: Record<string, string>; unitName: string; complete: () => void } | null {
  if (!input.command || !input.sessionId || !isSystemdRunAvailable()) {
    return null;
  }
  // The build does not keep the executable bit.
  try {
    fs.accessSync(DETACHED_EXEC, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(DETACHED_EXEC, 0o755);
    } catch {
      return null;
    }
  }

  const unitName = generateUnitName(input.jobId || input.sessionId);
  const logPath = getTurnLogPath(unitName);
  runningTurnsDb.recordTurn({
    unitName,
    jobId: input.jobId ?? null,
    sessionId: input.sessionId,
    backend: input.backend,
    logPath,
  });
  attachedUnits.add(unitName);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.CLI_DETACHED_UNIT = unitName;
  env.CLI_DETACHED_LOG = logPath;
  env.CLI_DETACHED_COMMAND = input.command;

  return {
    executable: DETACHED_EXEC,
    env,
    unitName,
    complete: () => {
      attachedUnits.delete(unitName);
      if (runningTurnsDb.getTurn(unitName)?.status === 'running' && !isTurnAlive(unitName)) {
        runningTurnsDb.completeTurn(unitName, getUnitExitCode(unitName, logPath));
      }
    },
  };
}

function stopUnit(unitName: string): Promise<void> {
  return new Promise((resolve) => {
    const stop = spawn('systemctl', ['--user', 'stop', `${unitName}.service`], { stdio: 'ignore' });
    stop.on('error', () => resolve());
    stop.on('close', () => resolve());
  });
}

/**
 * Stops a backend's detached turns for a session that this server process
 * does not drive itself: ones reattached after a restart. A new turn calls
 * this before it spawns, so a session never has two live CLI processes.
 */
export async function retireDetachedSessionTurns(sessionId: string, backend: string): Promise<number> {
  const turns = runningTurnsDb.listRunningTurns().filter((turn) => (
    turn.session_id === sessionId
    && turn.backend === backend
    && !attachedUnits.has(turn.unit_name)
    && !fallbackProcesses.has(turn.unit_name)
  ));
  for (const turn of turns) {
    if (isTurnAlive(turn.unit_name)) {
      console.log(`[DetachedTurns] Retiring reattached ${backend} turn ${turn.unit_name} for session ${sessionId}`);
      await stopUnit(turn.unit_name);
    }
    runningTurnsDb.completeTurn(turn.unit_name, getUnitExitCode(turn.unit_name, turn.log_path));
  }
  return turns.length;
}

/** Stops an in-flight turn for a session. */
export function abortTurn(sessionId: string): boolean {
  const turn = runningTurnsDb.getRunningTurnBySession(sessionId);
  if (!turn) return false;

  const fallback = fallbackProcesses.get(turn.unit_name);
  if (fallback && fallback.pid) {
    try {
      process.kill(-fallback.pid, 'SIGTERM');
    } catch {
      try { fallback.kill('SIGTERM'); } catch {}
    }
    runningTurnsDb.completeTurn(turn.unit_name, 143);
    return true;
  }

  if (isSystemdRunAvailable()) {
    try {
      spawnSync('systemctl', ['--user', 'stop', `${turn.unit_name}.service`], { stdio: 'ignore' });
      runningTurnsDb.completeTurn(turn.unit_name, 143);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function defaultLineParser(line: string, writer?: ProviderRuntimeWriter): void {
  if (!writer) return;
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.kind === 'string') {
        writer.send(parsed as NormalizedMessage);
        return;
      }
      if (typeof parsed.event === 'string' && typeof parsed.content === 'string') {
        writer.send({
          kind: parsed.event === 'error' ? 'error' : 'stream_delta',
          content: parsed.content,
        } as NormalizedMessage);
        return;
      }
    } catch {}
  }
}

/**
 * On server startup: inspects in-flight turns from the database.
 * If a unit is still running, attaches to its log and resumes streaming.
 * If a unit ended while the server was down, finalizes it from its exit status and log.
 */
export async function reattachActiveTurns(options: {
  chatRunRegistry?: {
    startRun: (input: {
      appSessionId: string;
      provider: never;
      providerSessionId: string | null;
      connection: null;
      userId: string | number | null;
    }) => { writer: ProviderRuntimeWriter } | null;
    getRun?: (appSessionId: string) => { writer: ProviderRuntimeWriter } | undefined;
    completeRunIfCurrent: (run: unknown, completion: { exitCode: number; aborted: boolean }) => void;
  };
  onTurnCompleted?: (turn: RunningTurnRow, exitCode: number) => void;
} = {}): Promise<void> {
  const turns = runningTurnsDb.listRunningTurns();
  if (turns.length === 0) return;

  const registry = options.chatRunRegistry ?? (await import('@/modules/websocket/index.js')).chatRunRegistry;

  console.log(`[DetachedTurns] Inspecting ${turns.length} in-flight turn(s) across restarts...`);

  for (const turn of turns) {
    const alive = isTurnAlive(turn.unit_name);

    if (alive) {
      console.log(`[DetachedTurns] Reattaching to live turn: ${turn.unit_name} (session: ${turn.session_id}, backend: ${turn.backend})`);
      const parser = backendLineParsers.get(turn.backend) ?? defaultLineParser;

      const run = registry.startRun({
        appSessionId: turn.session_id,
        provider: turn.backend as never,
        providerSessionId: null,
        connection: null,
        userId: null,
      }) ?? (registry.getRun ? registry.getRun(turn.session_id) : null);

      if (turn.job_id) {
        orchestratorJobsDb.update(turn.job_id, { in_turn: 1, state: 'active' });
      }

      void (async () => {
        try {
          await tailLogFile(turn.log_path, {
            isAlive: () => isTurnAlive(turn.unit_name),
            onLine: (line) => {
              if (run) {
                parser(line, run.writer, turn.session_id);
              }
            },
          });

          const exitCode = getUnitExitCode(turn.unit_name, turn.log_path);
          runningTurnsDb.completeTurn(turn.unit_name, exitCode);
          if (run) {
            registry.completeRunIfCurrent(run as never, { exitCode, aborted: false });
          }
          options.onTurnCompleted?.(turn, exitCode);
        } catch (error) {
          console.error(`[DetachedTurns] Reattached turn ${turn.unit_name} stream error:`, error);
          runningTurnsDb.completeTurn(turn.unit_name, 1);
          if (run) {
            registry.completeRunIfCurrent(run as never, { exitCode: 1, aborted: false });
          }
        }
      })();
    } else {
      console.log(`[DetachedTurns] Turn ${turn.unit_name} completed while server was down; finalizing...`);
      const exitCode = getUnitExitCode(turn.unit_name, turn.log_path);

      if (fs.existsSync(turn.log_path)) {
        const parser = backendLineParsers.get(turn.backend) ?? defaultLineParser;
        try {
          const content = fs.readFileSync(turn.log_path, 'utf8');
          const lines = content.split(/\r?\n/);
          for (const line of lines) {
            if (line.trim()) {
              parser(line);
            }
          }
        } catch (err) {
          console.warn(`[DetachedTurns] Could not read log for completed turn ${turn.unit_name}:`, err);
        }
      }

      runningTurnsDb.completeTurn(turn.unit_name, exitCode);
      options.onTurnCompleted?.(turn, exitCode);
    }
  }
}
