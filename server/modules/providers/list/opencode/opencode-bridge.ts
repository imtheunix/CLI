/**
 * OpenCode live-delta bridge.
 *
 * Runs as the main process of an OpenCode detached turn. It starts a private
 * `opencode serve` on a free loopback port, connects to its SSE event stream,
 * then runs the existing `opencode run` arguments with `--attach` pointing at
 * that server. Run stdout is forwarded unchanged (completed text, tools,
 * errors, step_finish); the SSE stream contributes only text deltas, written
 * as flat `{ type: 'text', part, delta }` events for the runtime's line parser.
 *
 * The bridge owns the server: it drains serve output, kills serve on normal,
 * error and signal exit, and never leaves an unmanaged daemon behind.
 */

import type { ChildProcess } from 'node:child_process';
import net from 'node:net';

import crossSpawn from 'cross-spawn';

const SERVE_START_TIMEOUT_MS = 10_000;
const SSE_ATTEMPT_TIMEOUT_MS = 2_000;
const SSE_RETRY_MS = 100;
const CLEANUP_TIMEOUT_MS = 2_000;

type SseDelta = {
  sessionId: string;
  messageId: string;
  partId: string;
  delta: string;
};

type RunEvent = {
  type?: unknown;
  sessionID?: unknown;
  sessionId?: unknown;
  part?: { id?: unknown; text?: unknown };
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const writeLine = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const writeError = (message: string): void => {
  writeLine(JSON.stringify({ type: 'error', error: message, message }));
};

const readArg = (args: string[], name: string): string | null => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
};

/** Inserts `--attach <url>` after the `run` subcommand, leaving the prompt last. */
const withAttach = (args: string[], url: string): string[] => {
  const runIndex = args.indexOf('run');
  if (runIndex === -1) {
    return ['run', '--attach', url, ...args];
  }
  return [...args.slice(0, runIndex + 1), '--attach', url, ...args.slice(runIndex + 1)];
};

const getFreeLoopbackPort = (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
};

const waitForExit = (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
};

const stopServe = async (serve: ChildProcess): Promise<void> => {
  if (serve.exitCode !== null || serve.signalCode !== null) {
    return;
  }
  try {
    serve.kill('SIGTERM');
  } catch {
    return;
  }
  if (!(await waitForExit(serve, CLEANUP_TIMEOUT_MS))) {
    try {
      serve.kill('SIGKILL');
    } catch {}
  }
};

const connectSse = async (
  url: string,
  signal: AbortSignal,
  serveExited: () => boolean,
): Promise<Response> => {
  const deadline = Date.now() + SERVE_START_TIMEOUT_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      throw new Error('OpenCode bridge aborted before the event stream connected');
    }
    if (serveExited()) {
      throw new Error('OpenCode serve exited before the event stream connected');
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), SSE_ATTEMPT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      });
      if (response.ok && response.body) {
        // Keep the outer-abort listener: it must also abort the open body.
        clearTimeout(timer);
        return response;
      }
      lastError = new Error(`OpenCode event stream returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    await delay(SSE_RETRY_MS);
  }
  throw lastError instanceof Error ? lastError : new Error('OpenCode event stream connection timed out');
};

const consumeSse = async (
  response: Response,
  onEvent: (event: unknown) => void,
  signal: AbortSignal,
): Promise<void> => {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data) {
            try {
              onEvent(JSON.parse(data));
            } catch {}
          }
        }
        newline = buffer.indexOf('\n');
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
};

const forwardRunStdout = (
  run: ChildProcess,
  onLine: (line: string) => void,
  onFinish?: () => void,
): Promise<void> => {
  return new Promise((resolve) => {
    if (!run.stdout) {
      onFinish?.();
      resolve();
      return;
    }
    let buffer = '';
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (buffer) {
        writeLine(buffer);
        onLine(buffer);
        buffer = '';
      }
      onFinish?.();
      resolve();
    };
    run.stdout.setEncoding('utf8');
    run.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        writeLine(line);
        onLine(line);
        newline = buffer.indexOf('\n');
      }
    });
    run.stdout.on('end', finish);
    run.once('error', finish);
    run.once('close', finish);
  });
};

const runBridge = async (): Promise<number> => {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const workingDir = readArg(args, '--dir') || process.cwd();
  const sessionArg = readArg(args, '--session');

  const port = await getFreeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const sseUrl = `${baseUrl}/event?directory=${encodeURIComponent(workingDir)}`;

  const serve = crossSpawn(
    'opencode',
    ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: workingDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // Serve output is not part of the run protocol; drain it so it cannot block.
  serve.stdout?.resume();
  serve.stderr?.resume();
  let serveExited = false;
  serve.once('exit', () => {
    serveExited = true;
  });
  serve.once('error', () => {
    serveExited = true;
  });

  const abortController = new AbortController();
  let run: ChildProcess | null = null;
  let runFinished = false;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (code: number): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shuttingDown = true;
    shutdownPromise = (async () => {
      abortController.abort();
      if (run && run.exitCode === null && run.signalCode === null) {
        try {
          run.kill('SIGTERM');
        } catch {}
      }
      await stopServe(serve);
      process.exit(code);
    })();
    return shutdownPromise;
  };

  process.once('SIGTERM', () => {
    void shutdown(143);
  });
  process.once('SIGINT', () => {
    void shutdown(130);
  });

  let targetSessionId = sessionArg;
  const completedTextPartIds = new Set<string>();

  const emitDelta = (delta: SseDelta): void => {
    writeLine(JSON.stringify({
      type: 'text',
      sessionID: delta.sessionId,
      part: {
        id: delta.partId,
        messageID: delta.messageId,
        sessionID: delta.sessionId,
        type: 'text',
      },
      delta: delta.delta,
    }));
  };

  const handleSseEvent = (event: unknown): void => {
    if (!event || typeof event !== 'object') {
      return;
    }
    const record = event as {
      type?: unknown;
      properties?: {
        sessionID?: unknown;
        messageID?: unknown;
        partID?: unknown;
        field?: unknown;
        delta?: unknown;
      };
    };
    if (record.type !== 'message.part.delta' || !record.properties) {
      return;
    }
    const properties = record.properties;
    if (properties.field !== 'text') {
      return;
    }
    if (
      typeof properties.sessionID !== 'string'
      || typeof properties.messageID !== 'string'
      || typeof properties.partID !== 'string'
      || typeof properties.delta !== 'string'
      || !properties.delta
    ) {
      return;
    }
    // The first owned-server event identifies the turn when run did not pass --session.
    if (!targetSessionId) {
      targetSessionId = properties.sessionID;
    }
    if (properties.sessionID !== targetSessionId) {
      return;
    }
    // Run stdout is authoritative for completed parts; a late delta would duplicate it.
    if (completedTextPartIds.has(properties.partID)) {
      return;
    }
    emitDelta({
      sessionId: properties.sessionID,
      messageId: properties.messageID,
      partId: properties.partID,
      delta: properties.delta,
    });
  };

  const handleRunLine = (line: string): void => {
    let event: RunEvent;
    try {
      event = JSON.parse(line) as RunEvent;
    } catch {
      return;
    }
    if (!event || typeof event !== 'object') {
      return;
    }
    const sessionId = typeof event.sessionID === 'string'
      ? event.sessionID
      : typeof event.sessionId === 'string'
        ? event.sessionId
        : null;
    if (sessionId && !targetSessionId) {
      targetSessionId = sessionId;
    }
    if (
      event.type === 'text'
      && event.part
      && typeof event.part.id === 'string'
      && typeof event.part.text === 'string'
    ) {
      completedTextPartIds.add(event.part.id);
    }
  };

  try {
    const response = await connectSse(sseUrl, abortController.signal, () => serveExited);
    const sseDone = consumeSse(response, handleSseEvent, abortController.signal).catch(() => {
      if (!shuttingDown && !runFinished) {
        // The run's completed text is authoritative. Drop the partial-delta
        // dedupe so a broken stream cannot leave the client with half a part.
        writeLine(JSON.stringify({ type: 'stream_reset' }));
      }
    });

    const runArgs = withAttach(args, baseUrl);
    run = crossSpawn('opencode', runArgs, {
      cwd: workingDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    run.stderr?.pipe(process.stderr);

    const runDone = forwardRunStdout(run, handleRunLine, () => {
      runFinished = true;
    });
    const exitCode = await new Promise<number>((resolve) => {
      run!.once('error', (error) => {
        writeError(error.message);
        resolve(1);
      });
      run!.once('exit', (code, signal) => {
        resolve(code ?? (signal ? 1 : 0));
      });
    });
    await runDone;
    abortController.abort();
    // Bounded: a stuck reader must not keep the turn's unit alive.
    await Promise.race([sseDone, delay(1000)]);
    await stopServe(serve);
    return exitCode;
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    await shutdown(1);
    return 1;
  }
};

void runBridge()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    writeError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
