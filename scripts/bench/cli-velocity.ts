#!/usr/bin/env node
/**
 * CLI velocity baseline: measures the latency of our own chat pipeline.
 *
 * It starts an isolated in-process server (free port, temp DATABASE_PATH) and
 * never contacts a live server or a real model. A stubbed provider turn emits
 * its first delta immediately, so the numbers are spawn/dispatch/transport
 * cost, not model time.
 *
 * Paths measured:
 *   1. chat open: GET /api/providers/sessions/recent + the first message page
 *      of the 10 most recent sessions;
 *   2. send -> first assistant delta: a real chat websocket, a canned
 *      `chat.send`, and a stubbed runtime that streams one text event;
 *   3. server event -> socket delivery: a synthetic event written through the
 *      real run writer, timed until the client socket receives it;
 *   4. session-list at scale: the per-project sidebar endpoint with >=10k
 *      fixture sessions, plus an EXPLAIN QUERY PLAN check for the composite
 *      (project_path, isArchived) index.
 *
 * Run with:
 *   npm run bench:cli-velocity
 *   npm run bench:cli-velocity -- --iterations 50 --sessions 20000 --json
 */
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';

import { AppError } from '@/shared/utils.js';

/**
 * Server modules are loaded only after DATABASE_PATH and HOME point at the
 * throwaway fixture. A static import would let a module open the real
 * ~/.cloudcli/auth.db before main() gets a chance to redirect it.
 */
type Runtime = {
  db: typeof import('@/modules/database/index.js');
  projectRouter: typeof import('@/modules/projects/projects.routes.js').default;
  providerRouter: typeof import('@/modules/providers/provider.routes.js').default;
  sessionHistoryCache: typeof import('@/modules/providers/services/session-history-cache.service.js').sessionHistoryCache;
  chatRunRegistry: typeof import('@/modules/websocket/services/chat-run-registry.service.js').chatRunRegistry;
  handleChatConnection: typeof import('@/modules/websocket/services/chat-websocket.service.js').handleChatConnection;
  connectedClients: typeof import('@/modules/websocket/services/websocket-state.service.js').connectedClients;
};

async function loadRuntime(): Promise<Runtime> {
  const [db, projects, providers, historyCache, runRegistry, chatSocket, socketState] = await Promise.all([
    import('@/modules/database/index.js'),
    import('@/modules/projects/projects.routes.js'),
    import('@/modules/providers/provider.routes.js'),
    import('@/modules/providers/services/session-history-cache.service.js'),
    import('@/modules/websocket/services/chat-run-registry.service.js'),
    import('@/modules/websocket/services/chat-websocket.service.js'),
    import('@/modules/websocket/services/websocket-state.service.js'),
  ]);
  return {
    db,
    projectRouter: projects.default,
    providerRouter: providers.default,
    sessionHistoryCache: historyCache.sessionHistoryCache,
    chatRunRegistry: runRegistry.chatRunRegistry,
    handleChatConnection: chatSocket.handleChatConnection,
    connectedClients: socketState.connectedClients,
  };
}

type Options = {
  iterations: number;
  warmup: number;
  sessions: number;
  recentSessions: number;
  messagePageLimit: number;
  stubDelayMs: number;
  json: boolean;
  out: string | null;
};

type Sample = { name: string; values: number[] };

type Summary = {
  name: string;
  count: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
};

const DEFAULTS: Options = {
  iterations: 30,
  warmup: 5,
  sessions: 10_000,
  recentSessions: 10,
  messagePageLimit: 20,
  stubDelayMs: 0,
  json: false,
  out: null,
};

function parseArgs(argv: string[]): Options {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--iterations': options.iterations = positiveInt(next(), arg); break;
      case '--warmup': options.warmup = nonNegativeInt(next(), arg); break;
      case '--sessions': options.sessions = positiveInt(next(), arg); break;
      case '--recent-sessions': options.recentSessions = positiveInt(next(), arg); break;
      case '--message-page-limit': options.messagePageLimit = positiveInt(next(), arg); break;
      case '--stub-delay-ms': options.stubDelayMs = nonNegativeInt(next(), arg); break;
      case '--json': options.json = true; break;
      case '--out': options.out = next(); break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function positiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: npm run bench:cli-velocity -- [options]

  --iterations <n>        measured iterations per path (default ${DEFAULTS.iterations})
  --warmup <n>            warmup iterations per path (default ${DEFAULTS.warmup})
  --sessions <n>          fixture sessions for the scale path (default ${DEFAULTS.sessions})
  --recent-sessions <n>   sessions opened in the chat-open path (default ${DEFAULTS.recentSessions})
  --message-page-limit <n> rows in the first message page (default ${DEFAULTS.messagePageLimit})
  --stub-delay-ms <n>     artificial delay before the stub's first delta (default ${DEFAULTS.stubDelayMs})
  --json                  print the report as JSON
  --out <path>            also write the report to a file
`);
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function summarize(sample: Sample): Summary {
  const sorted = [...sample.values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    name: sample.name,
    count: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length ? total / sorted.length : 0,
  };
}

function formatMs(value: number): string {
  return value.toFixed(3);
}

function printTable(summaries: Summary[]): void {
  const nameWidth = Math.max(28, ...summaries.map((summary) => summary.name.length));
  console.log('');
  console.log(`${'path'.padEnd(nameWidth)}  ${'n'.padStart(5)}  ${'p50 ms'.padStart(10)}  ${'p95 ms'.padStart(10)}  ${'min'.padStart(10)}  ${'max'.padStart(10)}`);
  console.log(`${'-'.repeat(nameWidth)}  ${'-'.repeat(5)}  ${'-'.repeat(10)}  ${'-'.repeat(10)}  ${'-'.repeat(10)}  ${'-'.repeat(10)}`);
  for (const summary of summaries) {
    console.log(
      `${summary.name.padEnd(nameWidth)}  ${String(summary.count).padStart(5)}  ${formatMs(summary.p50).padStart(10)}  ${formatMs(summary.p95).padStart(10)}  ${formatMs(summary.min).padStart(10)}  ${formatMs(summary.max).padStart(10)}`,
    );
  }
  console.log('');
}

function freePort(): Promise<number> {
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A codex rollout with a handful of turns, enough for a real first page. */
function buildTranscript(sessionId: string, turns: number): string {
  const rows: Array<Record<string, unknown>> = [];
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  for (let turn = 0; turn < turns; turn += 1) {
    const timestamp = new Date(base + turn * 1000).toISOString();
    const turnId = `${sessionId}-turn-${turn}`;
    rows.push({ type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: turnId } });
    rows.push({ type: 'event_msg', timestamp, payload: { type: 'user_message', kind: 'plain', message: `question ${turn}` } });
    rows.push({
      type: 'response_item',
      timestamp,
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer ${turn}` }] },
    });
    rows.push({ type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: turnId } });
  }
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

type Fixture = {
  directory: string;
  projectIds: string[];
  projectPaths: string[];
  recentSessionIds: string[];
  scaleProjectId: string;
  scaleProjectPath: string;
};

async function seedFixture(options: Options, directory: string, getConnection: Runtime['db']['getConnection']): Promise<Fixture> {
  const transcriptDirectory = path.join(directory, 'transcripts');
  await mkdir(transcriptDirectory, { recursive: true });

  const projectCount = Math.max(20, Math.ceil(options.sessions / 500));
  const projectIds: string[] = [];
  const projectPaths: string[] = [];
  for (let index = 0; index < projectCount; index += 1) {
    projectIds.push(`bench-project-${index}`);
    projectPaths.push(path.join(directory, 'projects', `project-${index}`));
  }

  const db = getConnection();
  const insertProject = db.prepare(
    'INSERT OR IGNORE INTO projects (project_id, project_path) VALUES (?, ?)',
  );
  const insertSession = db.prepare(
    `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
     VALUES (?, 'codex', ?, ?, ?, ?, 0, ?, ?)`,
  );

  const recentSessionIds: string[] = [];
  const recentCount = Math.max(options.recentSessions, 10);
  const now = Date.now();

  db.transaction(() => {
    for (let index = 0; index < projectCount; index += 1) {
      insertProject.run(projectIds[index], projectPaths[index]);
    }

    for (let index = 0; index < options.sessions; index += 1) {
      const sessionId = `bench-session-${index}`;
      const projectIndex = index % projectCount;
      const isRecent = index < recentCount;
      const updatedAt = isRecent
        ? new Date(now - index * 1000).toISOString()
        : new Date(Date.parse('2020-01-01T00:00:00.000Z') + index * 1000).toISOString();
      const transcriptPath = isRecent
        ? path.join(transcriptDirectory, `${sessionId}.jsonl`)
        : null;
      insertSession.run(
        sessionId,
        sessionId,
        `Bench session ${index}`,
        projectPaths[projectIndex],
        transcriptPath,
        updatedAt,
        updatedAt,
      );
      if (isRecent) recentSessionIds.push(sessionId);
    }
  })();

  await Promise.all(recentSessionIds.map((sessionId) => {
    const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);
    return writeFile(transcriptPath, buildTranscript(sessionId, 20), 'utf8');
  }));

  db.exec('ANALYZE');

  return {
    directory,
    projectIds,
    projectPaths,
    recentSessionIds: recentSessionIds.slice(0, options.recentSessions),
    scaleProjectId: projectIds[0],
    scaleProjectPath: projectPaths[0],
  };
}

function createHttpApp(runtime: Runtime): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/providers', runtime.providerRouter);
  app.use('/api/projects', runtime.projectRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  return app;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

type Frame = Record<string, unknown>;

/** Ordered frame stream: each wait consumes frames after the previous match. */
class FrameStream {
  private frames: Frame[] = [];
  private cursor = 0;
  private waiters: Array<{
    predicate: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(client: WebSocket) {
    client.on('message', (data) => {
      try {
        this.frames.push(JSON.parse(String(data)) as Frame);
      } catch {
        return;
      }
      this.pump();
    });
  }

  waitFor(predicate: (frame: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          reject(new Error('timed out waiting for a websocket frame'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
      this.pump();
    });
  }

  private pump(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      let matchIndex = -1;
      for (let index = this.cursor; index < this.frames.length; index += 1) {
        if (waiter.predicate(this.frames[index])) {
          matchIndex = index;
          break;
        }
      }
      if (matchIndex === -1) return;
      this.cursor = matchIndex + 1;
      this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(this.frames[matchIndex]);
    }
  }
}

type ChatHarness = {
  port: number;
  client: WebSocket;
  stream: FrameStream;
  serverSocket: WebSocket;
  close: () => Promise<void>;
};

async function startChatHarness(options: Options, handleChatConnection: Runtime['handleChatConnection']): Promise<ChatHarness> {
  const port = await freePort();
  const server = new WebSocketServer({ host: '127.0.0.1', port });
  let serverSocket: WebSocket | null = null;

  const runtime = {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    getPendingApprovalsForSession: () => [],
    resolveToolApproval: () => {},
    stopBackgroundTask: async () => false,
    abort: async () => true,
    run: async (
      provider: string,
      content: string,
      _runOptions: Record<string, unknown>,
      writer: { send: (message: Record<string, unknown>) => void },
    ) => {
      if (options.stubDelayMs > 0) await sleep(options.stubDelayMs);
      writer.send({
        kind: 'stream_delta',
        provider,
        content: `stub answer: ${content}`,
        timestamp: new Date().toISOString(),
      });
    },
  };

  server.on('connection', (socket) => {
    serverSocket = socket;
    handleChatConnection(socket, { user: { id: 1 } } as never, { runtime } as never);
  });
  await once(server, 'listening');

  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(client, 'open');
  const stream = new FrameStream(client);

  return {
    port,
    client,
    stream,
    get serverSocket() {
      if (!serverSocket) throw new Error('the chat websocket has not connected yet');
      return serverSocket;
    },
    close: async () => {
      client.terminate();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  } as ChatHarness;
}

function queryPlan(getConnection: Runtime['db']['getConnection'], sql: string, parameter: string): string {
  return (getConnection().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(parameter) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHome = process.env.HOME;
  const samples: Sample[] = [];
  const record = (name: string, value: number) => {
    let sample = samples.find((candidate) => candidate.name === name);
    if (!sample) {
      sample = { name, values: [] };
      samples.push(sample);
    }
    sample.values.push(value);
  };

  let fixture: Fixture | null = null;
  let fixtureDirectory: string | null = null;
  let httpServer: ReturnType<express.Express['listen']> | null = null;
  let harness: ChatHarness | null = null;
  let runtime: Runtime | null = null;

  try {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cli-velocity-'));
    fixtureDirectory = directory;
    process.env.DATABASE_PATH = path.join(directory, 'auth.db');
    const isolatedHome = path.join(directory, 'home');
    await mkdir(isolatedHome, { recursive: true });
    process.env.HOME = isolatedHome;

    // Only now may any server module load: it resolves DATABASE_PATH and HOME
    // at import time, and both must already point at the throwaway fixture.
    runtime = await loadRuntime();
    runtime.db.closeConnection();
    await runtime.db.initializeDatabase();
    fixture = await seedFixture(options, directory, runtime.db.getConnection);

    const app = createHttpApp(runtime);
    httpServer = app.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('the benchmark server has no port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const recentUrl = `${baseUrl}/api/providers/sessions/recent?limit=${options.recentSessions}`;
    const scaleUrl = `${baseUrl}/api/projects/${encodeURIComponent(fixture.scaleProjectId)}/sessions?limit=20`;

    // Path 4's index check: the sidebar page and count must use the composite
    // (project_path, isArchived) index, not a full scan.
    const pagePlan = queryPlan(
      runtime.db.getConnection,
      `SELECT session_id FROM sessions WHERE project_path = ? AND isArchived = 0
       ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC LIMIT 20 OFFSET 0`,
      fixture.scaleProjectPath,
    );
    const countPlan = queryPlan(
      runtime.db.getConnection,
      'SELECT COUNT(*) AS count FROM sessions WHERE project_path = ? AND isArchived = 0',
      fixture.scaleProjectPath,
    );
    if (!pagePlan.includes('idx_sessions_project_archived')) {
      throw new Error(`the project session page does not use the composite index:\n${pagePlan}`);
    }
    if (!countPlan.includes('idx_sessions_project_archived')) {
      throw new Error(`the project session count does not use the composite index:\n${countPlan}`);
    }

    const chatSessionId = 'bench-chat-session';
    const eventSessionId = 'bench-event-session';
    runtime.db.sessionsDb.createAppSession(chatSessionId, 'codex', fixture.scaleProjectPath, 'Bench chat');
    runtime.db.sessionsDb.createAppSession(eventSessionId, 'codex', fixture.scaleProjectPath, 'Bench event');
    harness = await startChatHarness(options, runtime.handleChatConnection);

    const totalIterations = options.warmup + options.iterations;
    for (let iteration = 0; iteration < totalIterations; iteration += 1) {
      const measured = iteration >= options.warmup;

      // 1. Chat open: the recent-session list, then the first page of each
      // recent session. The cache is cleared so every page is a cold open.
      for (const sessionId of fixture.recentSessionIds) runtime.sessionHistoryCache.invalidate(sessionId);
      const listStart = nowMs();
      await fetchJson(recentUrl);
      const listEnd = nowMs();
      const pageStart = nowMs();
      for (const sessionId of fixture.recentSessionIds) {
        await fetchJson(
          `${baseUrl}/api/providers/sessions/${encodeURIComponent(sessionId)}/messages?limit=${options.messagePageLimit}`,
        );
      }
      const pageEnd = nowMs();
      if (measured) {
        record('chat open: session list', listEnd - listStart);
        record('chat open: first message page (per session)', (pageEnd - pageStart) / fixture.recentSessionIds.length);
        record(`chat open: list + ${fixture.recentSessionIds.length} first pages`, pageEnd - listStart);
      }

      // 2. Send -> first assistant delta through the real chat websocket.
      const sendStart = nowMs();
      harness.client.send(JSON.stringify({
        type: 'chat.send',
        sessionId: chatSessionId,
        content: `bench ${iteration}`,
      }));
      await harness.stream.waitFor((frame) => frame.kind === 'stream_delta');
      const sendEnd = nowMs();
      await harness.stream.waitFor((frame) => frame.kind === 'complete');
      if (measured) record('send -> first assistant delta', sendEnd - sendStart);

      // 3. Server event -> socket delivery through the real run writer.
      const run = runtime.chatRunRegistry.startRun({
        appSessionId: eventSessionId,
        provider: 'codex',
        providerSessionId: null,
        connection: harness.serverSocket,
        userId: 1,
      });
      if (!run) throw new Error('could not start the synthetic event run');
      const marker = `synthetic-${iteration}`;
      const eventStart = nowMs();
      run.writer.send({
        kind: 'text',
        role: 'assistant',
        provider: 'codex',
        content: marker,
        timestamp: new Date().toISOString(),
      });
      await harness.stream.waitFor((frame) => frame.kind === 'text' && frame.content === marker);
      const eventEnd = nowMs();
      run.writer.sendComplete({ exitCode: 0 });
      await harness.stream.waitFor((frame) => frame.kind === 'complete');
      if (measured) record('server event -> socket delivery', eventEnd - eventStart);

      // 4. Session list at scale: the per-project sidebar endpoint.
      const scaleStart = nowMs();
      await fetchJson(scaleUrl);
      const scaleEnd = nowMs();
      if (measured) record('session list at scale (per project)', scaleEnd - scaleStart);
    }

    const summaries = samples.map(summarize);
    const report = {
      generatedAt: new Date().toISOString(),
      options,
      fixture: {
        sessions: options.sessions,
        projects: fixture.projectIds.length,
        recentSessions: fixture.recentSessionIds.length,
        scaleProjectSessions: options.sessions / fixture.projectIds.length,
      },
      index: {
        pagePlan,
        countPlan,
      },
      summaries,
    };

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`CLI velocity baseline — ${options.sessions} fixture sessions, ${options.iterations} measured iterations (${options.warmup} warmup)`);
      printTable(summaries);
      console.log('index check: project page and count use idx_sessions_project_archived');
    }

    if (options.out) {
      await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      if (!options.json) console.log(`report written to ${options.out}`);
    }
  } finally {
    if (harness) await harness.close();
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    runtime?.connectedClients.clear();
    runtime?.chatRunRegistry.clearAll();
    runtime?.db.closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
