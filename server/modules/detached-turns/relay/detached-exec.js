#!/usr/bin/env node
/**
 * Stand-in executable for an SDK that spawns its CLI itself (the Codex SDK:
 * `codexPathOverride`). It starts the real CLI in a relayed systemd unit and
 * passes stdin, stdout, stderr and the exit status through, so the SDK sees
 * an ordinary child while the CLI itself survives a server restart.
 *
 * Set by the server: CLI_DETACHED_UNIT, CLI_DETACHED_LOG, CLI_DETACHED_COMMAND
 * (the real CLI). When the unit cannot be started the real CLI runs here
 * directly, as it would without this wrapper.
 *
 * A SIGTERM (the SDK's abort, or the server's whole cgroup going down on a
 * restart) ends only this wrapper: the unit keeps running, and an abort stops
 * it by unit name (detached-turns abortTurn).
 */
import { spawn } from 'node:child_process';

import { attachRelayedProcess, launchRelayUnit } from './relay-process.js';

const {
  CLI_DETACHED_UNIT: unitName,
  CLI_DETACHED_LOG: logPath,
  CLI_DETACHED_COMMAND: command,
  ...env
} = process.env;
const args = process.argv.slice(2);

if (!command) {
  console.error('detached-exec: CLI_DETACHED_COMMAND is not set');
  process.exit(2);
}

const relayed = Boolean(unitName && logPath)
  && launchRelayUnit({ unitName, command, args, cwd: process.cwd(), env, logPath });
const child = relayed
  ? attachRelayedProcess({ unitName, logPath })
  : spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('error', (error) => {
  console.error(`detached-exec: ${error.message}`);
  process.exitCode = 127;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    if (!relayed) child.kill(signal);
    process.exit(143);
  });
}
