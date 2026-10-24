import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, sessionDraftsDb, userDb } from '@/modules/database/index.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { LLMProvider } from '@/shared/types.js';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const provider of ['claude', 'codex', 'opencode'] as LLMProvider[]) {
  for (const duringStartup of [true, false]) {
    test(`Stop cancels ${provider} ${duringStartup ? 'during startup' : 'while streaming'} and acknowledges without waiting for interrupt`, async () => {
      const previousPath = process.env.DATABASE_PATH;
      const directory = await mkdtemp(path.join(tmpdir(), 'chat-abort-'));
      closeConnection();
      process.env.DATABASE_PATH = path.join(directory, 'auth.db');
      await initializeDatabase();
      const socket = Object.assign(new EventEmitter(), {
        readyState: 1,
        frames: [] as Array<Record<string, unknown>>,
        send(data: string) { this.frames.push(JSON.parse(data)); },
      });
      let cancelled = false;
      let started = false;
      const aborts: string[] = [];
      const runtime: ProviderRuntimeGateway = {
        hasRuntime: () => true, hasBackgroundWork: () => false,
        getPendingApprovalsForSession: () => [], resolveToolApproval: () => {},
        pushUserMessage: async () => false, stopBackgroundTask: async () => false,
        // A graceful provider interrupt can stall; the run's signal must still
        // stop the process and release the UI without waiting for that reply.
        abort: (name, id) => { aborts.push(`${name}:${id}`); return new Promise(() => {}); },
        run: async (_name, _command, options, writer) => {
          started = true;
          const controller = options.abortController as AbortController;
          await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
          writer.send({ kind: 'text', provider, content: 'late output after Stop' });
          writer.send({ kind: 'status', provider, text: 'still running' });
          writer.send({ kind: 'complete', provider, exitCode: 0 });
        },
      };
      try {
        const user = userDb.createUser('stop-test', 'hash');
        sessionsDb.createAppSession('session', provider, directory);
        sessionDraftsDb.saveDraft(Number(user.id), 'session', { text: '', queuedMessage: { items: [{ id: 'queued', content: 'later' }] } });
        handleChatConnection(socket as never, { user: { id: user.id } } as never, { runtime });
        const turn = runDetachedChatTurn({ sessionId: 'session', userId: Number(user.id), content: 'work' }, { runtime });
        if (!duringStartup) await settle();
        socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: 'session' }));
        await settle();
        await turn;
        assert.deepEqual(aborts, [`${provider}:session`]);
        assert.equal(started, !duringStartup);
        assert.equal(cancelled, !duringStartup);
        assert.equal(chatRunRegistry.isProcessing('session'), false);
        assert.deepEqual(socket.frames.filter((frame) => frame.kind === 'complete').map((frame) => frame.aborted), [true]);
        assert.ok(!socket.frames.some((frame) => frame.content === 'late output after Stop' || frame.text === 'still running'));
        const queue = sessionDraftsDb.getDrafts(Number(user.id))[0].queuedMessage as { paused: boolean };
        assert.equal(queue.paused, true, 'Stop must not immediately start the next queued message');
      } finally {
        connectedClients.clear(); chatRunRegistry.clearAll(); closeConnection();
        if (previousPath === undefined) delete process.env.DATABASE_PATH;
        else process.env.DATABASE_PATH = previousPath;
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
