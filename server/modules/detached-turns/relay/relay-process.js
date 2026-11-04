/**
 * Server side of a relayed turn: starts the turn relay (turn-relay.js) in its
 * own transient systemd user unit and drives it through an object shaped like
 * a ChildProcess (stdin, stdout, stderr, exitCode, killed, kill, 'exit'), so
 * an SDK that only knows child processes can use a CLI that outlives the
 * server.
 *
 * stdin goes over the relay's unix socket; stdout and stderr are read back
 * from the turn log and `<log>.err`; the exit status comes from `<log>.exit`.
 *
 * Node built-ins only: the Codex wrapper (detached-exec.js) imports this under
 * plain `node`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

/** The stdin line that tells the relay to close the CLI's stdin. */
export const END_INPUT_LINE = '{"type":"cli_relay_end_input"}';

const RELAY_SCRIPT = fileURLToPath(new URL('./turn-relay.js', import.meta.url));
const POLL_INTERVAL_MS = 50;
const CONNECT_TIMEOUT_MS = 30_000;

// The SDKs kill every child they spawned from a process `exit` handler. For a
// relayed turn that would stop the unit on every server shutdown, which is
// the one thing the unit is there to survive, so kills are ignored from here.
let serverExiting = false;
process.once('exit', () => { serverExiting = true; });

/**
 * Files a relayed turn uses next to its log.
 * @param {string} logPath
 * @returns {{ socketPath: string, errPath: string, exitPath: string }}
 */
export function relayPaths(logPath) {
  let socketPath = `${logPath}.sock`;
  // Unix socket paths are limited to ~107 bytes.
  if (Buffer.byteLength(socketPath) > 100) {
    const digest = createHash('sha256').update(logPath).digest('hex').slice(0, 16);
    socketPath = path.join(os.tmpdir(), `cli-turn-${digest}.sock`);
  }
  return { socketPath, errPath: `${logPath}.err`, exitPath: `${logPath}.exit` };
}

/**
 * The exit status a relay recorded, or null while it has not.
 * @param {string} logPath
 * @returns {{ code: number | null, signal: string | null } | null}
 */
export function readRelayExit(logPath) {
  try {
    const status = JSON.parse(fs.readFileSync(relayPaths(logPath).exitPath, 'utf8'));
    return { code: status.code ?? null, signal: status.signal ?? null };
  } catch {
    return null;
  }
}

/**
 * A recorded exit status as one number (128 + signal number when killed).
 * @param {{ code: number | null, signal: string | null }} status
 * @returns {number}
 */
export function exitStatusCode(status) {
  if (typeof status.code === 'number') return status.code;
  const signalNumber = status.signal ? os.constants.signals[status.signal] : undefined;
  return signalNumber ? 128 + signalNumber : 1;
}

function isUnitActive(unitName) {
  const result = spawnSync('systemctl', ['--user', 'is-active', `${unitName}.service`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2000,
  });
  const state = (result.stdout || '').trim();
  return state === 'active' || state === 'activating' || state === 'deactivating';
}

/**
 * Starts the relay for one turn in a transient systemd user unit.
 * @param {{ unitName: string, command: string, args: string[], cwd: string, env: Record<string, string | undefined>, logPath: string, protocol?: string | null }} input
 * @returns {boolean} Whether the unit started
 */
export function launchRelayUnit({ unitName, command, args, cwd, env, logPath, protocol = null }) {
  const { socketPath } = relayPaths(logPath);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const systemdArgs = [
    '--user',
    `--unit=${unitName}`,
    '--collect',
    '--quiet',
    `--working-directory=${cwd}`,
    // A stop (abort, supersede) escalates to SIGKILL within bounds.
    '-pTimeoutStopSec=15',
  ];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && !/[\r\n]/.test(value)) {
      systemdArgs.push(`--setenv=${key}=${value}`);
    }
  }
  systemdArgs.push(
    '--',
    process.execPath,
    RELAY_SCRIPT,
    '--socket', socketPath,
    '--log', logPath,
    ...(protocol ? ['--protocol', protocol] : []),
    '--',
    command,
    ...args,
  );
  const result = spawnSync('systemd-run', systemdArgs, { stdio: 'ignore', timeout: 10_000 });
  return result.status === 0;
}

/**
 * @typedef {EventEmitter & {
 *   pid: undefined,
 *   unitName: string,
 *   exitCode: number | null,
 *   signalCode: string | null,
 *   killed: boolean,
 *   stdin: Writable,
 *   stdout: Readable,
 *   stderr: Readable,
 *   kill: (signal?: NodeJS.Signals) => boolean,
 * }} RelayedProcess
 */

/**
 * Attaches to a running relay: a ChildProcess-shaped handle on its CLI.
 * @param {{ unitName: string, logPath: string, signal?: AbortSignal }} input
 * @returns {RelayedProcess}
 */
export function attachRelayedProcess({ unitName, logPath, signal }) {
  const { socketPath, errPath } = relayPaths(logPath);
  const proc = /** @type {RelayedProcess} */ (new EventEmitter());
  proc.pid = undefined;
  proc.unitName = unitName;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = false;

  let socket = null;
  let socketClosed = false;
  let inputEnded = false;
  let finished = false;
  const pendingInput = [];
  const startedAt = Date.now();
  let lastUnitCheck = 0;

  proc.stdin = new Writable({
    write(chunk, _encoding, callback) {
      if (socket) socket.write(chunk, () => callback());
      else {
        pendingInput.push(chunk);
        callback();
      }
    },
    final(callback) {
      inputEnded = true;
      if (socket) socket.end(`\n${END_INPUT_LINE}\n`);
      callback();
    },
  });
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });

  const offsets = new Map([[logPath, 0], [errPath, 0]]);
  const drain = (file, stream) => {
    try {
      const size = fs.statSync(file).size;
      const offset = offsets.get(file);
      if (size <= offset) return;
      const buffer = Buffer.alloc(size - offset);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buffer, 0, buffer.length, offset);
      } finally {
        fs.closeSync(fd);
      }
      offsets.set(file, size);
      stream.push(buffer);
    } catch {
      // not created yet
    }
  };

  const finish = (status) => {
    if (finished) return;
    finished = true;
    clearInterval(poller);
    drain(logPath, proc.stdout);
    drain(errPath, proc.stderr);
    proc.stdout.push(null);
    proc.stderr.push(null);
    socket?.destroy();
    proc.exitCode = status.code;
    proc.signalCode = status.signal;
    setImmediate(() => {
      proc.emit('exit', status.code, status.signal);
      proc.emit('close', status.code, status.signal);
    });
  };

  const poller = setInterval(() => {
    drain(logPath, proc.stdout);
    drain(errPath, proc.stderr);
    const status = readRelayExit(logPath);
    if (status) {
      finish(status);
      return;
    }
    // A relay that died without recording a status (SIGKILL, crash).
    const disconnected = socketClosed || (!socket && Date.now() - startedAt > 2000);
    if (disconnected && Date.now() - lastUnitCheck > 1000) {
      lastUnitCheck = Date.now();
      if (!isUnitActive(unitName) && !readRelayExit(logPath)) {
        finish({ code: proc.killed ? null : 1, signal: proc.killed ? 'SIGKILL' : null });
      }
    }
  }, POLL_INTERVAL_MS);

  const connect = () => {
    if (finished) return;
    const attempt = net.createConnection(socketPath);
    attempt.once('connect', () => {
      socket = attempt;
      for (const chunk of pendingInput.splice(0)) socket.write(chunk);
      if (inputEnded) socket.end(`\n${END_INPUT_LINE}\n`);
    });
    attempt.once('error', () => {
      if (socket === attempt) return;
      attempt.destroy();
      if (Date.now() - startedAt < CONNECT_TIMEOUT_MS) setTimeout(connect, POLL_INTERVAL_MS);
      else socketClosed = true;
    });
    attempt.once('close', () => {
      if (socket === attempt) socketClosed = true;
    });
  };
  connect();

  proc.kill = (killSignal = 'SIGTERM') => {
    if (finished || serverExiting) return false;
    proc.killed = true;
    spawn('systemctl', ['--user', 'kill', `--signal=${killSignal}`, `${unitName}.service`], { stdio: 'ignore' })
      .on('error', () => {});
    return true;
  };

  if (signal) {
    if (signal.aborted) proc.kill('SIGTERM');
    else signal.addEventListener('abort', () => proc.kill('SIGTERM'), { once: true });
  }

  return proc;
}
