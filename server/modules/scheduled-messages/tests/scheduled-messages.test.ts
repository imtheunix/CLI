import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scheduledMessagesDb, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { dispatchDueScheduledMessages, dispatchQueuedMessages } from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';

const SESSION_ID = 'scheduled-session';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-messages-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('scheduler', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Scheduled session');
    await runTest(Number(user.id));
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

function createRuntime(
  runs: RunCall[],
  behaviour: 'ok' | 'throw' = 'ok',
  aborts: string[] = [],
  hasBackgroundWork: (sessionId: string) => boolean = () => false,
) {
  return {
    hasRuntime: () => true,
    hasBackgroundWork,
    stopBackgroundTask: async () => false,
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      if (behaviour === 'throw') {
        throw new Error('provider exploded');
      }
      runs.push({ provider, command, options });
      // A successful provider emits its terminal event before resolving. A
      // silent return triggers the gateway's failure safety net and pauses queues.
      chatRunRegistry.completeRun(String(options.sessionId), { exitCode: 0 });
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      return true;
    },
  };
}

test('a message due in the past is sent on the next pass, not skipped', async () => {
  await withIsolatedDatabase(async (userId) => {
    // The server was down when this came due.
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'run the nightly checks',
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    });

    const runs: RunCall[] = [];
    const sent = await dispatchDueScheduledMessages(createRuntime(runs));

    assert.equal(sent, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'run the nightly checks');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('a queued message is sent by the server without a browser connection', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: {
        content: 'continue on the VPS',
        options: { model: 'claude-opus-5' },
        attachments: [{ path: '/tmp/upload.png' }],
      },
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'continue on the VPS');
    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.deepEqual(runs[0].options.attachments, []);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('a queued message stays pending while its session is busy', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send after this run' },
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
      content: 'send after this run',
    });
  });
});

test('a queued message waits for background work its session\'s last turn left running', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send after the background job' },
    });
    // Turn A ended, so its run is completed, but it backgrounded a command
    // that is still running under A's CLI process.
    const runA = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });
    runA!.writer.sendComplete({ exitCode: 0 });
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);

    let backgroundWork = true;
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, 'ok', [], (sessionId) => sessionId === SESSION_ID && backgroundWork);

    // Starting B now would replace that process and stop the command.
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
      content: 'send after the background job',
    });

    // Once the work has reported back, B goes on the next pass.
    backgroundWork = false;
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'send after the background job');
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('a due message interrupts a run in progress instead of failing', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'the schedule wins',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    const aborts: string[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs, 'ok', aborts)), 1);

    assert.deepEqual(aborts, [SESSION_ID]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'the schedule wins');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('a message that is not due yet is left alone', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'later',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
  });
});

test('a due message is claimed once, so overlapping passes cannot double-send it', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'only once',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await Promise.all([
      dispatchDueScheduledMessages(runtime),
      dispatchDueScheduledMessages(runtime),
    ]);

    assert.equal(runs.length, 1);
  });
});

test('the composer settings it was scheduled with travel with it', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'with options',
      options: { model: 'claude-opus-5', permissionMode: 'plan' },
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const runs: RunCall[] = [];
    await dispatchDueScheduledMessages(createRuntime(runs));

    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.equal(runs[0].options.permissionMode, 'plan');
  });
});

test('a provider failure is recorded on the message instead of vanishing', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    await dispatchDueScheduledMessages(createRuntime([], 'throw'));

    const row = scheduledMessagesDb.listForSession(userId, SESSION_ID)[0];
    assert.equal(row.status, 'failed');
    assert.match(row.failure_reason ?? '', /provider exploded/);
  });
});

test('a cancelled message never fires', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'never mind',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    scheduledMessagesService.cancel(userId, scheduled.id);

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
  });
});

test('a failed message can be dismissed, and stays dismissed', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    await dispatchDueScheduledMessages(createRuntime([], 'throw'));
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'failed');

    scheduledMessagesService.cancel(userId, scheduled.id);

    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'cancelled');
  });
});

test('cancelling something that already fired is refused', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'gone',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    await dispatchDueScheduledMessages(createRuntime([]));

    assert.throws(
      () => scheduledMessagesService.cancel(userId, scheduled.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_MESSAGE_NOT_PENDING',
    );
  });
});

test('one user cannot cancel another user\'s scheduled message', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'mine',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    assert.throws(
      () => scheduledMessagesService.cancel(userId + 1, scheduled.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_MESSAGE_NOT_PENDING',
    );
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
  });
});

test('scheduling validates its input', async () => {
  await withIsolatedDatabase(async (userId) => {
    const base = { userId, sessionId: SESSION_ID, scheduledFor: new Date(Date.now() + 1000).toISOString() };

    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, content: '   ' }),
      (error: Error & { code?: string }) => error.code === 'CONTENT_REQUIRED',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, content: 'hi', scheduledFor: 'not a date' }),
      (error: Error & { code?: string }) => error.code === 'INVALID_SCHEDULE_TIME',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({
        ...base,
        content: 'hi',
        scheduledFor: new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString(),
      }),
      (error: Error & { code?: string }) => error.code === 'SCHEDULE_TOO_FAR_AHEAD',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, sessionId: 'nope', content: 'hi' }),
      (error: Error & { code?: string }) => error.code === 'SESSION_NOT_FOUND',
    );
  });
});

test('a persistent queue consumes one item per pass, in order, keeping each attachment and session isolated', async () => {
  await withIsolatedDatabase(async (userId) => {
    // Use the durable descriptors returned by the upload endpoint. Name-only
    // fixtures are correctly rejected by the websocket attachment boundary.
    const items = [1, 2, 3].map((index) => ({ id: String(index), content: `prompt ${index}`, attachments: [{ path: path.join(getGlobalImageAssetsDir(), `${index}.png`), name: `${index}.png` }] }));
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: 'unsent', queuedMessage: { items } });
    sessionDraftsDb.saveDraft(userId, 'other-session', { text: '', queuedMessage: { items: [{ content: 'other' }] } });
    const runs: RunCall[] = [];
    for (let index = 0; index < 3; index++) {
      assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
      assert.equal(runs[index].command, `prompt ${index + 1}`);
      assert.deepEqual(runs[index].options.attachments, items[index].attachments);
    }
    assert.equal(sessionDraftsDb.getDrafts(userId).find((draft) => draft.scope === SESSION_ID)?.text, 'unsent');
    assert.ok(sessionDraftsDb.getDrafts(userId).find((draft) => draft.scope === 'other-session')?.queuedMessage);
  });
});

test('paused queues survive reload, and a failed turn preserves and pauses the rest', async () => {
  await withIsolatedDatabase(async (userId) => {
    const items = [{ id: 'a', content: 'first' }, { id: 'b', content: 'second' }];
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { items } });
    sessionDraftsDb.pauseQueue(SESSION_ID);
    closeConnection();
    await initializeDatabase();
    assert.equal(await dispatchQueuedMessages(createRuntime([])), 0);
    const queue = sessionDraftsDb.getDrafts(userId)[0].queuedMessage as { items: unknown[]; paused: boolean };
    assert.deepEqual(queue.items, items);
    assert.equal(queue.paused, true);
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { items, paused: false } });
    await dispatchQueuedMessages(createRuntime([], 'throw'));
    const failed = sessionDraftsDb.getDrafts(userId)[0].queuedMessage as { items: unknown[]; paused: boolean };
    assert.equal(failed.paused, true);
    assert.ok(failed.items.some((item) => (item as { id: string }).id === 'b'));
    assert.equal(await dispatchQueuedMessages(createRuntime([])), 0);
  });
});

test('Send now interrupts the active turn, consumes the selected item and leaves the others ordered', async () => {
  await withIsolatedDatabase(async (userId) => {
    const items = ['a', 'b', 'c'].map((id) => ({ id, content: id }));
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { items, forceId: 'b' } });
    chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: null, userId });
    const runs: RunCall[] = [];
    const aborts: string[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs, 'ok', aborts)), 1);
    assert.deepEqual(aborts, [SESSION_ID]);
    assert.equal(runs[0].command, 'b');
    const remaining = sessionDraftsDb.getDrafts(userId)[0].queuedMessage as { items: { id: string }[] };
    assert.deepEqual(remaining.items.map((item) => item.id), ['a', 'c']);
  });
});


test('Send now reserves dispatch through async interruption so another poll cannot overtake it', async () => {
  await withIsolatedDatabase(async (userId) => {
    const items = ['a', 'b', 'c'].map((id) => ({ id, content: id }));
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { items, forceId: 'b' } });
    const oldRun = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: null, userId })!;
    let finishAbort!: () => void;
    const abortPending = new Promise<void>((resolve) => { finishAbort = resolve; });
    const runs: RunCall[] = [];
    const runtime = {
      ...createRuntime(runs),
      abort: async () => {
        // Providers can finish the old stream before interrupt() has returned.
        oldRun.writer.sendComplete({ exitCode: 0 });
        await abortPending;
        return true;
      },
    };
    const sending = dispatchQueuedMessages(runtime);
    try {
      assert.equal(await dispatchQueuedMessages(runtime), 0);
      assert.equal(runs.length, 0);
    } finally {
      finishAbort();
      await sending;
    }
    assert.deepEqual(runs.map((run) => run.command), ['b']);
    const remaining = sessionDraftsDb.getDrafts(userId)[0].queuedMessage as { items: { id: string }[] };
    assert.deepEqual(remaining.items.map((item) => item.id), ['a', 'c']);
  });
});

test('Send now dispatches the chosen item from an idle queue without aborting', async () => {
  await withIsolatedDatabase(async (userId) => {
    const items = ['a', 'b', 'c'].map((id) => ({ id, content: id }));
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: 'draft', queuedMessage: { items, paused: false, forceId: 'b' } });
    const runs: RunCall[] = [];
    const aborts: string[] = [];
    await dispatchQueuedMessages(createRuntime(runs, 'ok', aborts));
    assert.deepEqual(runs.map((run) => run.command), ['b']);
    assert.deepEqual(aborts, []);
    const remaining = sessionDraftsDb.getDrafts(userId)[0];
    assert.equal(remaining.text, 'draft');
    assert.deepEqual((remaining.queuedMessage as { items: { id: string }[] }).items.map((item) => item.id), ['a', 'c']);
  });
});

test('a competing interactive turn during interruption stays running and the selected item is restored', async () => {
  await withIsolatedDatabase(async (userId) => {
    const items = ['a', 'b', 'c'].map((id) => ({ id, content: id }));
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { items, forceId: 'b' } });
    chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: null, userId });
    const runs: RunCall[] = [];
    let competingRun: ReturnType<typeof chatRunRegistry.startRun>;
    const runtime = {
      ...createRuntime(runs),
      abort: async () => {
        chatRunRegistry.completeRun(SESSION_ID, { exitCode: 0 });
        competingRun = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: null, userId });
        return true;
      },
    };
    await dispatchQueuedMessages(runtime);
    assert.deepEqual(runs, []);
    assert.equal(chatRunRegistry.getRun(SESSION_ID), competingRun!);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].queuedMessage, { items, forceId: 'b' });
  });
});

test('Send now can interrupt a queued turn that is still running after its reservation', async () => {
  await withIsolatedDatabase(async (userId) => {
    const items = ['a', 'b', 'c'].map((id) => ({ id, content: id }));
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { items, forceId: 'b' } });
    const runs: RunCall[] = [];
    const aborts: string[] = [];
    let finishFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { finishFirst = resolve; });
    const runtime = {
      ...createRuntime(runs, 'ok', aborts),
      run: async (provider: string, command: string, options: Record<string, unknown>) => {
        runs.push({ provider, command, options });
        if (command === 'b') await firstPending;
        else chatRunRegistry.completeRun(SESSION_ID, { exitCode: 0 });
      },
    };
    const firstSend = dispatchQueuedMessages(runtime);
    // The gateway yields before entering the provider, after reserving the run.
    await Promise.resolve();
    try {
      sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { items: [items[0], items[2]], forceId: 'c' } });
      await dispatchQueuedMessages(runtime);
      assert.deepEqual(runs.map((run) => run.command), ['b', 'c']);
      assert.deepEqual(aborts, [SESSION_ID]);
      assert.deepEqual((sessionDraftsDb.getDrafts(userId)[0].queuedMessage as { items: unknown[] }).items, [items[0]]);
    } finally {
      finishFirst();
      await firstSend;
    }
  });
});
