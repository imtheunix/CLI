import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb, sessionDraftsDb, userDb } from '@/modules/database/index.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

test('local websocket server delivers Send now and Stop to phone and desktop idle subscriptions', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chat-live-transport-'));
  const previousPath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const clients: WebSocket[] = [];
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true, hasBackgroundWork: () => false,
    getPendingApprovalsForSession: () => [], resolveToolApproval: () => {},
    stopBackgroundTask: async () => false,
    abort: async () => true,
    run: async (_provider, content, options, writer) => {
      writer.send({ kind: 'text', provider: 'claude', content: `live answer: ${content}` });
      await new Promise<void>((resolve) => (options.abortController as AbortController).signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  };
  try {
    const user = userDb.createUser('transport-test', 'hash');
    sessionsDb.createAppSession('session', 'claude', directory);
    server.on('connection', (socket) => handleChatConnection(socket, { user: { id: user.id } } as never, { runtime }));
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const connect = async () => {
      const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
      clients.push(client);
      const frames: Array<Record<string, unknown>> = [];
      client.on('message', (data) => frames.push(JSON.parse(String(data))));
      await once(client, 'open');
      client.send(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: 'session', lastSeq: 0 }] }));
      await once(client, 'message');
      assert.equal(frames[0].kind, 'chat_subscribed');
      return { client, frames };
    };
    const phone = await connect();
    const desktop = await connect();
    sessionDraftsDb.saveDraft(Number(user.id), 'session', { text: '', queuedMessage: { items: [{ id: 'now', content: 'send this now' }], forceId: 'now' } });
    const answer = once(phone.client, 'message');
    const dispatched = runDetachedChatTurn({ sessionId: 'session', userId: Number(user.id), content: 'send this now' }, { runtime });
    await answer;
    // Status and answer can be separate socket frames in the same tick.
    while (!phone.frames.some((frame) => frame.kind === 'text' && frame.role !== 'user')) await once(phone.client, 'message');
    desktop.client.send(JSON.stringify({ type: 'chat.abort', sessionId: 'session' }));
    while (!phone.frames.some((frame) => frame.kind === 'complete')) await once(phone.client, 'message');
    while (!desktop.frames.some((frame) => frame.kind === 'complete')) await once(desktop.client, 'message');
    await dispatched;
    for (const browser of [phone, desktop]) {
      assert.equal(browser.frames.find((frame) => frame.kind === 'text' && frame.role === 'user')?.content, 'send this now');
      assert.equal(browser.frames.find((frame) => frame.kind === 'text' && frame.role !== 'user')?.content, 'live answer: send this now');
      assert.equal(browser.frames.find((frame) => frame.kind === 'complete')?.aborted, true);
    }
    assert.equal(chatRunRegistry.isProcessing('session'), false);
  } finally {
    clients.forEach((client) => client.terminate());
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    connectedClients.clear(); chatRunRegistry.clearAll(); closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a detached turn records the model, effort and agent it runs with on the session', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chat-agent-record-'));
  const previousPath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true, hasBackgroundWork: () => false,
    getPendingApprovalsForSession: () => [], resolveToolApproval: () => {},
    stopBackgroundTask: async () => false,
    abort: async () => true,
    run: async () => {},
  };
  try {
    const user = userDb.createUser('agent-record-test', 'hash');
    // A hub session on OpenCode: `tjob hub new` set model, effort and agent on the row.
    sessionsDb.createAppSession('hub-session', 'opencode', directory);
    sessionsDb.setSessionModel('hub-session', 'morph/morph-kimik31');
    sessionsDb.setSessionEffort('hub-session', 'low');
    sessionsDb.setSessionAgent('hub-session', 'morph-hub');

    await runDetachedChatTurn(
      { sessionId: 'hub-session', userId: Number(user.id), content: 'wake', options: { agent: 'morph-hub' } },
      { runtime },
    );

    const row = sessionsDb.getSessionById('hub-session');
    assert.ok(row);
    assert.equal(row.model, 'morph/morph-kimik31');
    assert.equal(row.effort, 'low');
    assert.equal(row.agent, 'morph-hub', 'the turn keeps the session on its agent');
  } finally {
    connectedClients.clear(); chatRunRegistry.clearAll(); closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
