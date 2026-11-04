/**
 * Turn relay: the main process of a detached turn's systemd unit.
 *
 * Runs the agent CLI as its child so the CLI outlives the CLI server. The
 * child's stdout is appended to the turn log (the server tails it, before and
 * after a restart), its stderr to `<log>.err`, and its exit status is written
 * to `<log>.exit`. The child's stdin comes from whichever server is connected
 * on the unix socket, one JSON line at a time; the END_INPUT line closes it.
 *
 * With `--protocol claude` the relay also covers for a server that went away
 * mid-turn (a restart): it answers the control requests the CLI is waiting on
 * (tool permissions are denied, hooks continue) and closes stdin once the turn
 * reports its `result`, so the CLI finishes the turn and exits instead of
 * waiting forever for a client that no longer exists.
 *
 * Node built-ins only: this file runs under plain `node`, from the source tree
 * and from dist-server alike.
 *
 * Usage: node turn-relay.js --socket S --log L [--protocol claude] -- command ...args
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';

import { END_INPUT_LINE } from './relay-process.js';

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  const flags = argv.slice(0, separator === -1 ? argv.length : separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    options[flags[i].replace(/^--/, '')] = flags[i + 1];
  }
  return { options, command };
}

/** Answer for a control request nobody else will answer (the server is gone). */
function orphanControlResponse(request) {
  const subtype = request.request?.subtype;
  let response = {};
  if (subtype === 'can_use_tool') {
    response = { behavior: 'deny', message: 'The CLI server restarted while this tool waited for approval; ask again.' };
  } else if (subtype === 'hook_callback') {
    response = { continue: true };
  } else if (subtype !== 'interrupt') {
    return {
      type: 'control_response',
      response: { subtype: 'error', request_id: request.request_id, error: 'The CLI server restarted during this request.' },
    };
  }
  return { type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response } };
}

function splitLines(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  };
}

function main() {
  const { options, command } = parseArgs(process.argv.slice(2));
  if (!options.socket || !options.log || command.length === 0) {
    console.error('turn-relay: --socket, --log and a command are required');
    process.exit(2);
  }
  const claudeProtocol = options.protocol === 'claude';
  const exitPath = `${options.log}.exit`;

  const out = fs.createWriteStream(options.log, { flags: 'a' });
  const err = fs.createWriteStream(`${options.log}.err`, { flags: 'a' });
  const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });

  let client = null;
  let inputEnded = false;
  // Control requests the CLI sent that no response has gone back for yet.
  const pendingRequests = new Map();
  // True between a turn's first output and its `result`.
  let inTurn = false;

  const writeInput = (line) => {
    if (inputEnded || !child.stdin.writable) return;
    child.stdin.write(`${line}\n`);
  };
  const endInput = () => {
    if (inputEnded) return;
    inputEnded = true;
    child.stdin.end();
  };
  const orphaned = () => client === null;
  const coverForServer = () => {
    for (const request of pendingRequests.values()) {
      writeInput(JSON.stringify(orphanControlResponse(request)));
    }
    pendingRequests.clear();
    if (!inTurn) endInput();
  };

  child.stdin.on('error', () => { /* the CLI exited first */ });
  child.stderr.pipe(err);
  child.stdout.on('data', (chunk) => out.write(chunk));
  if (claudeProtocol) {
    child.stdout.on('data', splitLines((line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === 'control_request') {
        if (orphaned()) writeInput(JSON.stringify(orphanControlResponse(message)));
        else pendingRequests.set(message.request_id, message);
        return;
      }
      if (message.type === 'control_response' || message.type === 'control_cancel_request' || message.type === 'keep_alive') return;
      if (message.type === 'result') {
        inTurn = false;
        if (orphaned()) endInput();
      } else {
        inTurn = true;
      }
    }));
  }

  const server = net.createServer((socket) => {
    client?.destroy();
    client = socket;
    socket.on('data', splitLines((line) => {
      if (!line.trim()) return;
      if (line === END_INPUT_LINE) {
        endInput();
        return;
      }
      if (claudeProtocol) {
        try {
          const message = JSON.parse(line);
          if (message.type === 'control_response') pendingRequests.delete(message.response?.request_id);
          // A new user message starts a turn before the CLI says anything.
          if (message.type === 'user') inTurn = true;
        } catch { /* forwarded as is */ }
      }
      writeInput(line);
    }));
    socket.on('error', () => {});
    socket.on('close', () => {
      if (client !== socket) return;
      client = null;
      if (claudeProtocol && !inputEnded) coverForServer();
    });
  });
  try { fs.unlinkSync(options.socket); } catch { /* not there */ }
  server.listen(options.socket);

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      try { child.kill(signal); } catch { /* gone */ }
    });
  }

  child.on('error', (error) => {
    err.write(`turn-relay: ${error.message}\n`);
    fs.writeFileSync(exitPath, JSON.stringify({ code: 127, signal: null }));
    process.exit(127);
  });
  child.on('close', (code, signal) => {
    const status = code ?? 128 + (os.constants.signals[signal] ?? 0);
    out.end(() => {
      fs.writeFileSync(exitPath, JSON.stringify({ code, signal }));
      server.close();
      try { fs.unlinkSync(options.socket); } catch { /* gone */ }
      err.end(() => process.exit(status));
    });
  });
}

main();
