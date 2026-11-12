import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { authenticateToken, generateToken } from '@/modules/auth/index.js';
import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { createChatEventsRouter } from '@/modules/websocket/chat-events.routes.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import { clearAllTurnPhases, getTurnPhase } from '@/modules/websocket/services/turn-phase.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { NormalizedMessage, RealtimeClientConnection, SessionUpsertedEvent } from '@/shared/types.js';

type Frame = Record<string, unknown>;

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = '';
  private readonly decoder = new TextDecoder();

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  async next(): Promise<Frame> {
    for (;;) {
      const boundary = this.buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const raw = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        const data = raw
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length))
          .join('\n');
        if (data) {
          return JSON.parse(data) as Frame;
        }
        continue;
      }

      const { value, done } = await this.reader.read();
      if (done) {
        throw new Error('SSE stream ended before the next frame');
      }
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withServer(
  run: (baseUrl: string, token: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'chat-events-sse-'));
  const previousPath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();

  const user = userDb.createUser('sse-test', 'hash');
  const token = generateToken(user);
  const app = express();
  app.use('/api/chat', authenticateToken, createChatEventsRouter({
    fetchHistory: async () => ({
      messages: [{
        id: 'persisted-1',
        sessionId: 'session',
        timestamp: new Date().toISOString(),
        provider: 'claude',
        kind: 'text',
        role: 'assistant',
        content: 'persisted answer',
      }],
    }),
    buildSessionUpserted: async (sessionId): Promise<SessionUpsertedEvent> => ({
      kind: 'session_upserted',
      sessionId,
      providerSessionId: null,
      provider: 'claude',
      session: {
        id: sessionId,
        summary: 'Session',
        messageCount: 1,
        lastActivity: new Date().toISOString(),
      },
      project: null,
      timestamp: new Date().toISOString(),
    }),
    hasBackgroundWork: () => false,
  }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${address.port}`, token);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    connectedClients.clear();
    chatRunRegistry.clearAll();
    clearAllTurnPhases();
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

test('SSE resync snapshot carries history, live events and session deltas, and a reconnect misses nothing', { timeout: 15_000 }, async () => {
  await withServer(async (baseUrl, token) => {
    sessionsDb.createAppSession('session', 'claude', '/tmp/project');

    const second = deferred();
    const third = deferred();
    const finish = deferred();
    const runtime: ProviderRuntimeGateway = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      getPendingApprovalsForSession: () => [],
      resolveToolApproval: () => {},
      stopBackgroundTask: async () => false,
      abort: async () => true,
      run: async (_provider, _content, _options, writer) => {
        writer.send({ kind: 'text', provider: 'claude', role: 'assistant', content: 'first live answer' });
        await second.promise;
        writer.send({ kind: 'text', provider: 'claude', role: 'assistant', content: 'second live answer' });
        await third.promise;
        writer.send({ kind: 'text', provider: 'claude', role: 'assistant', content: 'third live answer' });
        await finish.promise;
      },
    };

    const turn = runDetachedChatTurn(
      { sessionId: 'session', userId: 1, content: 'go' },
      { runtime },
    );
    await waitFor(() => chatRunRegistry.replayEvents('session', 0).some((event) => event.content === 'first live answer'));

    const firstResponse = await fetch(`${baseUrl}/api/chat/events?sessionId=session&token=${encodeURIComponent(token)}`);
    assert.equal(firstResponse.status, 200);
    assert.match(firstResponse.headers.get('content-type') ?? '', /text\/event-stream/);
    const firstReader = new SseReader(firstResponse.body as ReadableStream<Uint8Array>);

    const snapshot = await firstReader.next();
    assert.equal(snapshot.kind, 'chat_resync');
    assert.equal(snapshot.sessionId, 'session');
    assert.deepEqual(
      (snapshot.messages as NormalizedMessage[]).map((message) => message.content),
      ['persisted answer'],
      'the snapshot starts with the last persisted messages',
    );
    assert.ok(
      (snapshot.events as NormalizedMessage[]).some((event) => event.content === 'first live answer'),
      'the snapshot includes the live run events buffered before connect',
    );
    assert.equal((snapshot.sessions as SessionUpsertedEvent[])[0]?.kind, 'session_upserted');
    assert.equal(snapshot.isProcessing, true);

    second.resolve();
    let secondFrame = await firstReader.next();
    while (secondFrame.kind !== 'text' || secondFrame.content !== 'second live answer') {
      secondFrame = await firstReader.next();
    }
    const lastSeq = Number(secondFrame.seq);
    assert.ok(Number.isFinite(lastSeq));
    await firstReader.close();

    third.resolve();
    await waitFor(() => chatRunRegistry.replayEvents('session', lastSeq).some((event) => event.content === 'third live answer'));

    const reconnectResponse = await fetch(
      `${baseUrl}/api/chat/events?sessionId=session&lastSeq=${lastSeq}&token=${encodeURIComponent(token)}`,
    );
    const reconnectReader = new SseReader(reconnectResponse.body as ReadableStream<Uint8Array>);
    const reconnectSnapshot = await reconnectReader.next();
    assert.equal(reconnectSnapshot.kind, 'chat_resync');
    assert.ok(
      (reconnectSnapshot.events as NormalizedMessage[]).some((event) => event.content === 'third live answer'),
      'the reconnect snapshot carries the event produced while the first connection was closed',
    );
    assert.ok(
      !(reconnectSnapshot.events as NormalizedMessage[]).some((event) => event.content === 'second live answer'),
      'lastSeq keeps already-seen events out of the replay',
    );
    await reconnectReader.close();

    finish.resolve();
    await turn;
  });
});

test('a stubbed turn emits dispatching, prefill, streaming and tool phases, then clears on complete', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chat-turn-phase-'));
  const previousPath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();

  const frames: Frame[] = [];
  const connection: RealtimeClientConnection = {
    readyState: WS_OPEN_STATE,
    send(data: string) {
      frames.push(JSON.parse(data) as Frame);
    },
  };
  connectedClients.add(connection);

  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    getPendingApprovalsForSession: () => [],
    resolveToolApproval: () => {},
    stopBackgroundTask: async () => false,
    abort: async () => true,
    run: async (_provider, _content, _options, writer) => {
      writer.send({ kind: 'stream_delta', provider: 'claude', content: 'hello' });
      writer.send({ kind: 'tool_use', provider: 'claude', toolName: 'Read', toolId: 'tool-1' });
    },
  };

  try {
    sessionsDb.createAppSession('phase-session', 'claude', directory);
    await runDetachedChatTurn(
      { sessionId: 'phase-session', userId: 1, content: 'go' },
      { runtime },
    );

    const phases = frames
      .filter((frame) => frame.kind === 'turn_phase' && frame.sessionId === 'phase-session')
      .map((frame) => frame.phase);
    assert.deepEqual(phases, ['dispatching', 'prefill', 'streaming', 'tool:Read']);
    assert.equal(getTurnPhase('phase-session'), null, 'complete clears the live phase');
  } finally {
    connectedClients.delete(connection);
    connectedClients.clear();
    chatRunRegistry.clearAll();
    clearAllTurnPhases();
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
