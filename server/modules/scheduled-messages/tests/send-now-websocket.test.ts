import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { dispatchQueuedMessages } from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { chatRunRegistry, connectedClients, createWebSocketServer } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

type Frame = Record<string, unknown>;

/**
 * The reported bug end to end through a real websocket: a turn started from
 * the composer is still working, a queued message gets "Send now", and the
 * running turn must end and the message go out as the next turn — then Stop
 * must stop that turn too.
 */
test('Send now on a busy session stops the running turn and sends the queued message next; Stop stops it', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'send-now-websocket-'));
  const previousPath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const server = createServer();
  const clients: WebSocket[] = [];
  const started: string[] = [];
  const aborted: string[] = [];
  // A provider that works until it is cancelled, like a long tool-calling turn.
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true, hasBackgroundWork: () => false,
    getPendingApprovalsForSession: () => [], resolveToolApproval: () => {},
    stopBackgroundTask: async () => false,
    abort: async (_provider, sessionId) => { aborted.push(sessionId); return true; },
    run: async (_provider, content, options, writer) => {
      started.push(content);
      writer.send({ kind: 'text', provider: 'claude', content: `working on: ${content}` });
      const signal = (options.abortController as AbortController).signal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  };
  try {
    const user = userDb.createUser('send-now-test', 'hash');
    sessionsDb.createAppSession('session', 'claude', directory);
    // The production gateway, with platform-mode auth standing in for a token.
    createWebSocketServer(server, {
      verifyClient: { isPlatform: true, authenticateWebSocket: () => ({ id: Number(user.id), username: user.username }) },
      chat: { runtime },
      shell: {} as never,
      getPluginPort: () => null,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const connect = async () => {
      const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      clients.push(client);
      const frames: Frame[] = [];
      client.on('message', (data) => frames.push(JSON.parse(String(data))));
      await once(client, 'open');
      client.send(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: 'session', lastSeq: 0 }] }));
      await once(client, 'message');
      return { client, frames };
    };
    const waitForFrame = async (browser: { client: WebSocket; frames: Frame[] }, match: (frame: Frame) => boolean) => {
      const deadline = Date.now() + 3_000;
      while (!browser.frames.some(match)) {
        const left = deadline - Date.now();
        assert.ok(left > 0, `expected frame never arrived; got ${JSON.stringify(browser.frames.map((frame) => frame.content ?? frame.kind))}`);
        await Promise.race([once(browser.client, 'message'), new Promise((resolve) => setTimeout(resolve, left))]);
      }
    };
    const desktop = await connect();
    const phone = await connect();

    desktop.client.send(JSON.stringify({ type: 'chat.send', sessionId: 'session', content: 'long task', options: {} }));
    await waitForFrame(phone, (frame) => frame.content === 'working on: long task');
    assert.equal(chatRunRegistry.isProcessing('session'), true);

    // The composer queued a message and the user pressed "Send now" on it.
    sessionDraftsDb.saveDraft(Number(user.id), 'session', {
      text: '',
      queuedMessage: { items: [{ id: 'q', content: 'do this instead' }], paused: false, forceId: 'q' },
    });
    // Resolves when the turn it starts settles, which is only after the Stop below.
    const dispatched = dispatchQueuedMessages(runtime);

    for (const browser of [desktop, phone]) {
      await waitForFrame(browser, (frame) => frame.content === 'working on: do this instead');
      const kinds = browser.frames
        .filter((frame) => frame.kind === 'complete' || frame.kind === 'text')
        .map((frame) => frame.kind === 'complete' ? `complete${frame.aborted ? ' (aborted)' : ''}` : `${frame.role ?? 'assistant'}: ${frame.content}`);
      assert.deepEqual(kinds, [
        'assistant: working on: long task',
        'complete (aborted)',
        'user: do this instead',
        'assistant: working on: do this instead',
      ], 'the running turn ends before the queued message goes out as the next turn');
    }
    assert.deepEqual(started, ['long task', 'do this instead']);
    assert.deepEqual(aborted, ['session']);
    assert.equal(sessionDraftsDb.getDrafts(Number(user.id))[0]?.queuedMessage ?? null, null, 'the item left the queue');

    // Stop from the phone ends the turn Send now started.
    const before = phone.frames.length;
    phone.client.send(JSON.stringify({ type: 'chat.abort', sessionId: 'session' }));
    await waitForFrame(phone, (frame) => phone.frames.indexOf(frame) >= before && frame.kind === 'complete');
    assert.equal(phone.frames.slice(before).find((frame) => frame.kind === 'complete')?.aborted, true);
    assert.equal(chatRunRegistry.isProcessing('session'), false);
    assert.deepEqual(aborted, ['session', 'session']);
    assert.equal(await dispatched, 1);
  } finally {
    clients.forEach((client) => client.terminate());
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    connectedClients.clear(); chatRunRegistry.clearAll(); closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
