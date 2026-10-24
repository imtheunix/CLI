import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * Drafts moved out of the browser and into auth.db so a message half-typed on
 * one device can be finished on another — the case the composer could not serve
 * at all before, because a draft only existed on the machine it was typed on.
 *
 * Each test loads a fresh module copy, because the store reads its localStorage
 * mirror once at module scope.
 */

type SavedDraft = { scope: string; text: string; queuedMessage?: unknown };

const savedDrafts: SavedDraft[] = [];
const deletedScopes: string[] = [];
let serverDrafts: unknown[] = [];
let draftsRequestFailed = false;
let pendingSave: Promise<void> | null = null;
let pendingHydrate: Promise<Response> | null = null;
// Statuses the next saves answer with, in order; 200 once empty.
let saveStatuses: number[] = [];

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      drafts: async () => {
        if (pendingHydrate) return pendingHydrate;
        if (draftsRequestFailed) {
          throw new Error('offline');
        }
        return new Response(JSON.stringify({ success: true, drafts: serverDrafts }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      saveDraft: async (scope: string, draft: { text: string; queuedMessage?: unknown }) => {
        savedDrafts.push({ scope, ...draft });
        if (pendingSave) await pendingSave;
        return new Response('{}', { status: saveStatuses.shift() ?? 200 });
      },
      deleteDraft: async (scope: string) => {
        deletedScopes.push(scope);
        return new Response('{}', { status: 200 });
      },
    },
  },
}));

const loadStore = async () => {
  vi.resetModules();
  return import('@/shared/chatDrafts');
};

beforeEach(() => {
  localStorage.clear();
  savedDrafts.length = 0;
  deletedScopes.length = 0;
  serverDrafts = [];
  draftsRequestFailed = false;
  pendingSave = null;
  pendingHydrate = null;
  saveStatuses = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('a draft is readable synchronously and reaches the server after the debounce', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'half a thought');

  assert.equal(store.readDraftText('session-a'), 'half a thought');
  assert.deepEqual(savedDrafts, [], 'the request must not fire on every keystroke');

  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts, [
    { scope: 'session-a', text: 'half a thought', queuedMessage: null },
  ]);
});

test('each session keeps its own draft', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'for A');
  store.writeDraftText('session-b', 'for B');

  assert.equal(store.readDraftText('session-a'), 'for A');
  assert.equal(store.readDraftText('session-b'), 'for B');
});

test('a chat with no session yet is scoped to its project', async () => {
  const store = await loadStore();

  store.writeDraftText('project:p1', 'unsent');

  assert.equal(store.readDraftText('project:p1'), 'unsent');
  assert.equal(store.readDraftText('session-a'), '');
});

test('clearing a draft deletes it on the server instead of storing an empty one', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'typed');
  await vi.advanceTimersByTimeAsync(1_500);
  savedDrafts.length = 0;

  store.writeDraftText('session-a', '');
  await vi.advanceTimersByTimeAsync(1_500);

  assert.deepEqual(savedDrafts, []);
  assert.deepEqual(deletedScopes, ['session-a']);
});

test('a draft written in one page load is readable synchronously in the next', async () => {
  const first = await loadStore();
  first.writeDraftText('session-a', 'survives a reload');

  // No hydrate: this is the first paint of the next load, before any request
  // could have resolved.
  const second = await loadStore();
  assert.equal(second.readDraftText('session-a'), 'survives a reload');
});

test('hydrate brings in a draft typed on another device', async () => {
  serverDrafts = [{ scope: 'session-a', text: 'typed on the laptop', queuedMessage: null }];

  const store = await loadStore();
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'typed on the laptop');
});

test('hydrate removes a mirrored queue after the server claims it', async () => {
  const store = await loadStore();
  store.writeQueuedMessage('session-a', { content: 'server-owned queue' });
  assert.equal(store.readQueuedMessage('session-a')?.content, 'server-owned queue');

  // A server can only consume the queue after its save has been acknowledged.
  await vi.advanceTimersByTimeAsync(0);
  serverDrafts = [];
  await store.hydrateChatDrafts();

  assert.equal(store.readQueuedMessage('session-a'), null);
});

test('hydrate does not overwrite a scope the user is typing into right now', async () => {
  serverDrafts = [{ scope: 'session-a', text: 'stale server copy', queuedMessage: null }];

  const store = await loadStore();
  store.writeDraftText('session-a', 'what I am writing');
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'what I am writing');
});

test('a failed hydrate keeps the mirrored draft rather than blanking the composer', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'local work');
  await vi.advanceTimersByTimeAsync(1_500);

  draftsRequestFailed = true;
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'local work');
});

test('a queued message round-trips alongside the draft text', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'still editing');
  store.writeQueuedMessage('session-a', { content: 'send this next', attachments: [] });

  assert.equal(store.readDraftText('session-a'), 'still editing');
  const queued = store.readQueuedMessage('session-a');
  assert.equal(queued?.content, 'send this next');
  assert.deepEqual(queued?.attachments, []);
  assert.ok(queued?.id);
  assert.equal(savedDrafts.length, 1, 'queue actions persist without waiting for the draft debounce');
  assert.deepEqual(savedDrafts, [{
    scope: 'session-a',
    text: 'still editing',
    queuedMessage: { items: [queued], paused: false },
  }]);
});

test('a queued message with neither text nor attachments reads as absent', async () => {
  const store = await loadStore();

  store.writeQueuedMessage('session-a', { content: '   ', attachments: [] });

  assert.equal(store.readQueuedMessage('session-a'), null);
});

test('legacy image-only descriptors are still readable as attachments', async () => {
  const store = await loadStore();

  store.writeQueuedMessage('session-a', { content: '', images: [{ name: 'shot.png' }] });

  assert.deepEqual(store.readQueuedMessage('session-a')?.attachments, [{ name: 'shot.png' }]);
});

test('clearing the queued message leaves the draft text alone', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'keep me');
  store.writeQueuedMessage('session-a', { content: 'queued' });

  store.clearQueuedMessage('session-a');

  assert.equal(store.readQueuedMessage('session-a'), null);
  assert.equal(store.readDraftText('session-a'), 'keep me');
});

test('subscribers are notified on a write', async () => {
  const store = await loadStore();
  const listener = vi.fn();
  const unsubscribe = store.subscribeToChatDrafts(listener);

  store.writeDraftText('session-a', 'typed');
  assert.equal(listener.mock.calls.length, 1);

  // Writing the same text again changes nothing, so nobody is woken.
  store.writeDraftText('session-a', 'typed');
  assert.equal(listener.mock.calls.length, 1);

  unsubscribe();
  store.writeDraftText('session-a', 'more');
  assert.equal(listener.mock.calls.length, 1);
});

test('reset clears the drafts so the next user does not see them', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'private');

  store.resetChatDrafts();

  assert.equal(store.readDraftText('session-a'), '');
  assert.equal(localStorage.getItem('chat-drafts'), null);
});

test('multiple queued items retain order, attachments and session scope across a page reload', async () => {
  const store = await loadStore();
  store.writeQueuedMessage('session-a', { id: 'one', content: 'first', attachments: [{ name: 'notes.txt' }] });
  store.writeQueuedMessage('session-a', { id: 'two', content: 'second' });
  store.writeQueuedMessage('session-b', { id: 'three', content: 'other session' });
  const restored = await loadStore();
  assert.deepEqual(restored.readQueuedMessages('session-a').map((item) => item.content), ['first', 'second']);
  assert.deepEqual(restored.readQueuedMessages('session-a')[0].attachments, [{ name: 'notes.txt' }]);
  assert.equal(restored.readQueuedMessages('session-b')[0].content, 'other session');
  assert.equal(savedDrafts.length, 3, 'each queue action is immediately persisted');
});

test('queue saves stay ordered and polling preserves edits until the server acknowledges them', async () => {
  const store = await loadStore();
  let finishSave!: () => void;
  pendingSave = new Promise<void>((resolve) => { finishSave = resolve; });
  store.writeQueuedMessage('session-a', { id: 'one', content: 'first' });
  store.writeQueuedMessage('session-a', { id: 'two', content: 'second' });
  assert.equal(savedDrafts.length, 1, 'a later save waits for the older request');
  await store.hydrateChatDrafts();
  assert.deepEqual(store.readQueuedMessages('session-a').map((item) => item.id), ['one', 'two']);

  pendingSave = null;
  finishSave();
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(savedDrafts.length, 2);
  assert.deepEqual((savedDrafts[1].queuedMessage as { items: { id: string }[] }).items.map((item) => item.id), ['one', 'two']);
});

test('a poll started before a queue edit cannot erase that edit even after its save finishes', async () => {
  const store = await loadStore();
  let finishHydrate!: (response: Response) => void;
  pendingHydrate = new Promise<Response>((resolve) => { finishHydrate = resolve; });
  const hydrate = store.hydrateChatDrafts();
  store.writeQueuedMessage('session-a', { id: 'new', content: 'keep this' });
  await vi.advanceTimersByTimeAsync(0);
  finishHydrate(new Response(JSON.stringify({ drafts: [] })));
  await hydrate;
  assert.equal(store.readQueuedMessages('session-a')[0]?.content, 'keep this');
});

test('overlapping polls make progress on slow connections and discard older snapshots arriving last', async () => {
  const store = await loadStore();
  let finishFirst!: (response: Response) => void;
  let finishSecond!: (response: Response) => void;
  let finishThird!: (response: Response) => void;
  const snapshot = (text: string) => new Response(JSON.stringify({ drafts: [{ scope: 'session-a', text }] }));
  pendingHydrate = new Promise<Response>((resolve) => { finishFirst = resolve; });
  const first = store.hydrateChatDrafts();
  pendingHydrate = new Promise<Response>((resolve) => { finishSecond = resolve; });
  const second = store.hydrateChatDrafts();
  finishFirst(snapshot('first'));
  await first;
  assert.equal(store.readDraftText('session-a'), 'first', 'a pending later poll does not block progress');
  pendingHydrate = new Promise<Response>((resolve) => { finishThird = resolve; });
  const third = store.hydrateChatDrafts();
  finishThird(snapshot('third'));
  await third;
  finishSecond(snapshot('second'));
  await second;
  assert.equal(store.readDraftText('session-a'), 'third', 'an older late response cannot undo a newer snapshot');
});


test('a retried save never writes back a queued item the server already sent', async () => {
  const store = await loadStore();
  store.writeQueuedMessage('session-a', { content: 'send this next', attachments: [] });
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(savedDrafts.length, 1, 'the server confirmed the queue');

  // While this device is offline the server dispatches the item...
  serverDrafts = [{ scope: 'session-a', text: '', queuedMessage: null }];
  // ...and an edit to the draft text fails to save.
  saveStatuses = [503];
  store.writeDraftText('session-a', 'next thought');
  await vi.advanceTimersByTimeAsync(1_500);
  assert.equal(savedDrafts.length, 2);

  await vi.advanceTimersByTimeAsync(3_500);
  const retry = savedDrafts.at(-1);
  assert.deepEqual(retry, { scope: 'session-a', text: 'next thought', queuedMessage: null },
    'the retry keeps the server queue, so the sent item is not queued again');
  assert.equal(store.readQueuedMessage('session-a'), null);
});

test('a queue changed on this device while offline is still retried as it stands', async () => {
  const store = await loadStore();
  saveStatuses = [503];
  store.writeQueuedMessage('session-a', { content: 'written offline', attachments: [] });
  await vi.advanceTimersByTimeAsync(3_500);
  assert.equal(savedDrafts.length, 2);
  assert.equal((savedDrafts[1].queuedMessage as { items: Array<{ content: string }> }).items[0].content, 'written offline');
});

test('a failed forced save stays visible and survives polling until the automatic retry succeeds', async () => {
  const store = await loadStore();
  store.writeQueuedMessage('session-a', { id: 'one', content: 'send this' });
  await vi.advanceTimersByTimeAsync(0);
  saveStatuses = [500]; // A full server disk fails the draft write.
  store.replaceQueuedMessages('session-a', store.readQueuedMessages('session-a'), false, 'one');
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(store.hasChatDraftSaveError('session-a'), true);
  assert.equal(store.hasChatDraftSaveError('session-b'), false);
  await store.hydrateChatDrafts();
  assert.equal(store.readQueuedMessages('session-a')[0].id, 'one');

  await vi.advanceTimersByTimeAsync(3_000);
  assert.equal(store.hasChatDraftSaveError('session-a'), false);
  const retry = savedDrafts.at(-1);
  assert.ok(retry);
  assert.equal((retry.queuedMessage as { forceId: string }).forceId, 'one');
});

test('a save the server refuses outright is not resent forever', async () => {
  const store = await loadStore();
  saveStatuses = [400];
  store.writeDraftText('session-a', 'refused');
  await vi.advanceTimersByTimeAsync(1_500);
  await vi.advanceTimersByTimeAsync(20_000);
  assert.equal(savedDrafts.length, 1);
  assert.equal(store.hasChatDraftSaveError('session-a'), true);
  await store.hydrateChatDrafts();
  assert.equal(store.readDraftText('session-a'), 'refused', 'kept on this device');
  store.resetChatDrafts();
  assert.equal(store.hasChatDraftSaveError('session-a'), false);
});
