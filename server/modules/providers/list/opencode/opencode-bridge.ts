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
 * error and signal exit, and never leaves an unmanaged daemon behind. If the
 * private server or its event stream cannot start, the bridge falls back to an
 * ordinary authoritative `opencode run` instead of failing the turn.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import net from 'node:net';

import crossSpawn from 'cross-spawn';

const SERVE_START_TIMEOUT_MS = 10_000;
const SSE_ATTEMPT_TIMEOUT_MS = 2_000;
const SSE_RETRY_MS = 100;
const CLEANUP_TIMEOUT_MS = 2_000;
const MAX_BUFFERED_DELTAS = 1_000;

type SseDelta = {
  sessionId: string;
  messageId: string;
  partId: string;
  delta: string;
};

type SseEvent = {
  id: string | null;
  data: unknown;
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

/**
 * Spawns a child in its own process group on POSIX so cleanup can reach
 * grandchildren that inherited the run's stdout. Windows keeps the default
 * process handling and falls back to a direct child kill.
 */
const spawnChild = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
  return crossSpawn(command, args, {
    ...options,
    detached: process.platform !== 'win32',
  });
};

const killGroup = (child: ChildProcess | null, signal: NodeJS.Signals): void => {
  if (!child || !child.pid) {
    return;
  }
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {}
};

/**
 * Bounded process-tree teardown. The group is signalled even when the leader
 * already exited, because a grandchild may still hold the inherited stdout.
 */
const terminate = async (child: ChildProcess | null): Promise<void> => {
  if (!child) {
    return;
  }
  killGroup(child, 'SIGTERM');
  await waitForExit(child, CLEANUP_TIMEOUT_MS);
  killGroup(child, 'SIGKILL');
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

/**
 * Parses a complete SSE stream. Events are accumulated across split chunks and
 * multiline `data:` fields; the SSE `id:` field is carried as the event
 * identity so replayed deltas can be suppressed without dropping legitimate
 * repeated chunks that have different ids.
 */
const consumeSse = async (
  response: Response,
  onEvent: (event: SseEvent) => void,
  signal: AbortSignal,
): Promise<void> => {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let eventId: string | null = null;

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventId = null;
      return;
    }
    const data = dataLines.join('\n');
    const id = eventId;
    dataLines = [];
    eventId = null;
    if (!data) {
      return;
    }
    try {
      onEvent({ id, data: JSON.parse(data) });
    } catch {}
  };

  const processLine = (line: string) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) {
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'id') {
      eventId = value || null;
    }
  };

  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) {
          line = line.slice(0, -1);
        }
        processLine(line);
        newline = buffer.indexOf('\n');
      }
    }
    if (buffer) {
      processLine(buffer.replace(/\r$/, ''));
      buffer = '';
    }
    dispatch();
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

const readDelta = (event: unknown): SseDelta | null => {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const record = event as {
    type?: unknown;
    properties?: {
      sessionID?: unknown;
      messageID?: unknown;
      partID?: unknown;
      assistantMessageID?: unknown;
      textID?: unknown;
      field?: unknown;
      delta?: unknown;
    };
  };
  const properties = record.properties;
  if (!properties) {
    return null;
  }
  if (record.type === 'message.part.delta') {
    if (properties.field !== 'text') {
      return null;
    }
    if (
      typeof properties.sessionID !== 'string'
      || typeof properties.messageID !== 'string'
      || typeof properties.partID !== 'string'
      || typeof properties.delta !== 'string'
      || !properties.delta
    ) {
      return null;
    }
    return {
      sessionId: properties.sessionID,
      messageId: properties.messageID,
      partId: properties.partID,
      delta: properties.delta,
    };
  }
  if (record.type === 'session.next.text.delta') {
    if (
      typeof properties.sessionID !== 'string'
      || typeof properties.assistantMessageID !== 'string'
      || typeof properties.textID !== 'string'
      || typeof properties.delta !== 'string'
      || !properties.delta
    ) {
      return null;
    }
    return {
      sessionId: properties.sessionID,
      messageId: properties.assistantMessageID,
      partId: properties.textID,
      delta: properties.delta,
    };
  }
  return null;
};

const runBridge = async (): Promise<number> => {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const workingDir = readArg(args, '--dir') || process.cwd();
  const sessionArg = readArg(args, '--session');

  const port = await getFreeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const sseUrl = `${baseUrl}/event?directory=${encodeURIComponent(workingDir)}`;

  const abortController = new AbortController();
  let serve: ChildProcess | null = null;
  let run: ChildProcess | null = null;
  let runFinished = false;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let sseDone: Promise<void> | null = null;
  let usingServe = false;

  let targetSessionId = sessionArg;
  let rootSelected = Boolean(sessionArg);
  const bufferedDeltas: SseDelta[] = [];
  const completedTextPartIds = new Set<string>();
  const seenEventIds = new Set<string>();

  const emitReset = (): void => {
    writeLine(JSON.stringify({ type: 'stream_reset' }));
  };

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

  const forwardDelta = (delta: SseDelta): void => {
    // Run stdout is authoritative for completed parts; a late delta would duplicate it.
    if (completedTextPartIds.has(delta.partId)) {
      return;
    }
    emitDelta(delta);
  };

  const flushBufferedDeltas = (): void => {
    const pending = bufferedDeltas.splice(0);
    for (const delta of pending) {
      if (delta.sessionId === targetSessionId) {
        forwardDelta(delta);
      }
    }
  };

  const handleSseEvent = (event: SseEvent): void => {
    if (shuttingDown || runFinished) {
      return;
    }
    if (event.id) {
      if (seenEventIds.has(event.id)) {
        return;
      }
      seenEventIds.add(event.id);
    }
    const delta = readDelta(event.data);
    if (!delta) {
      return;
    }
    // Without --session the root is only known from run stdout. Buffer until
    // then so a subagent's first event cannot become the target.
    if (!rootSelected) {
      if (bufferedDeltas.length < MAX_BUFFERED_DELTAS) {
        bufferedDeltas.push(delta);
      }
      return;
    }
    if (delta.sessionId !== targetSessionId) {
      return;
    }
    forwardDelta(delta);
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
    if (
      event.type === 'text'
      && event.part
      && typeof event.part.id === 'string'
      && typeof event.part.text === 'string'
    ) {
      completedTextPartIds.add(event.part.id);
    }
    if (sessionId && !rootSelected) {
      targetSessionId = sessionId;
      rootSelected = true;
      flushBufferedDeltas();
    }
  };

  const shutdown = (code: number): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shuttingDown = true;
    shutdownPromise = (async () => {
      abortController.abort();
      await terminate(run);
      await terminate(serve);
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

  try {
    try {
      serve = spawnChild(
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

      const response = await connectSse(sseUrl, abortController.signal, () => serveExited);
      usingServe = true;
      sseDone = consumeSse(response, handleSseEvent, abortController.signal)
        .then(() => {
          if (!shuttingDown && !runFinished) {
            // A clean early EOF is still a broken live stream: stdout must win.
            bufferedDeltas.length = 0;
            emitReset();
          }
        })
        .catch(() => {
          if (!shuttingDown && !runFinished) {
            bufferedDeltas.length = 0;
            emitReset();
          }
        });
    } catch (error) {
      if (shuttingDown) {
        // The signal handler owns teardown; do not race it with process.exit.
        await shutdownPromise;
        return 1;
      }
      // Startup transport failure: fall back to an ordinary authoritative run.
      await terminate(serve);
      serve = null;
      usingServe = false;
      bufferedDeltas.length = 0;
      emitReset();
    }

    const runArgs = usingServe ? withAttach(args, baseUrl) : args;
    run = spawnChild('opencode', runArgs, {
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

    // Kill descendants that inherited stdout, then let the reader drain.
    await terminate(run);
    await Promise.race([runDone, delay(CLEANUP_TIMEOUT_MS)]);
    run.stdout?.destroy();
    await Promise.race([runDone, delay(100)]);

    abortController.abort();
    // Bounded: a stuck reader must not keep the turn's unit alive.
    await Promise.race([sseDone ?? Promise.resolve(), delay(1000)]);
    await terminate(serve);
    if (shuttingDown) {
      // The signal handler owns teardown; do not race it with process.exit.
      await shutdownPromise;
    }
    return exitCode;
  } catch (error) {
    if (shuttingDown) {
      await shutdownPromise;
      return 1;
    }
    writeError(error instanceof Error ? error.message : String(error));
    await terminate(run);
    await terminate(serve);
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
