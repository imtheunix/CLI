import { api } from '@/shared/api';
import type { QueuedSendOptions } from '@/shared/types';

/**
 * Unsent composer text and queued messages, stored in `auth.db` rather than in
 * the browser.
 *
 * This is what lets a message half-typed on a laptop be finished on a phone —
 * the case the composer previously could not serve at all, because a draft only
 * existed on the machine it was typed on. As with the preference store, a
 * localStorage mirror is kept purely so a reload shows the draft on the first
 * paint instead of a blank composer that fills in a moment later.
 *
 * A scope is a session id, or `project:<projectId>` for a chat that has not
 * been sent yet and so has no session. Drafts used to be keyed by project
 * alone, which meant every session in a project shared one draft.
 */

/** A queued message as it is stored: text plus the send options it was composed under. */
export type StoredQueuedMessage = {
  id?: string;
  content: string;
  options?: QueuedSendOptions;
  /** Legacy image-only descriptors retained for queued draft compatibility. */
  images?: unknown[];
  /**
   * JSON-safe descriptors returned by POST /api/assets/files. Unlike browser
   * File objects, they can follow a queued message across session switches.
   */
  attachments?: unknown[];
};

type DraftRecord = {
  text: string;
  queuedMessage: StoredQueuedMessage | { items: StoredQueuedMessage[]; paused?: boolean; forceId?: string } | null;
};

/** Fired after any draft changes, from a local write or from a hydrate. */
export const CHAT_DRAFTS_CHANGED_EVENT = 'chat-drafts:changed';

const MIRROR_STORAGE_KEY = 'chat-drafts';

/**
 * Longer than the preference debounce: this fires on every keystroke, and a
 * draft is only ever read back on a reload or on a device switch, so trading a
 * little latency for far fewer requests is the right side of the trade.
 */
const SERVER_WRITE_DEBOUNCE_MS = 1_000;

/**
 * Backoff for a draft write that failed (network down, server restarting).
 * The scope stays pending while it waits, which also keeps it protected from
 * being wiped by a successful hydrate — otherwise a queued message that never
 * reached the server would be deleted by the next sync instead of retried.
 */
const SERVER_WRITE_RETRY_MS = 3_000;

const EMPTY_DRAFT: DraftRecord = { text: '', queuedMessage: null };

const listeners = new Set<() => void>();

let drafts = new Map<string, DraftRecord>();
const pendingScopes = new Set<string>();
// Per-scope writes stay ordered, and polling must not replace unacknowledged edits.
const serverWrites = new Map<string, Promise<void>>();
const localRevisions = new Map<string, number>();
let storeGeneration = 0;
let hydrationRevision = 0;
let lastHydratedRevision = 0;
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;
let serverWriteRetryTimer: ReturnType<typeof setTimeout> | null = null;
// The queue the server last confirmed per scope (a write it accepted, or a
// hydrate). A retry whose queue is still exactly that one may be stale: the
// server dispatches queued items on its own, so it re-reads the server's queue
// rather than writing back an item that was already sent.
const confirmedQueues = new Map<string, string>();
const queueKey = (queued: unknown): string => JSON.stringify(queued ?? null);

/** The server's current queue for a scope; undefined when it cannot be read. */
async function readServerQueue(scope: string): Promise<DraftRecord['queuedMessage'] | undefined> {
  try {
    const response = await api.user.drafts();
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { drafts?: Array<{ scope?: unknown; queuedMessage?: unknown }> };
    const found = (payload.drafts ?? []).find((draft) => draft.scope === scope);
    return found && isRecord(found.queuedMessage) ? (found.queuedMessage as DraftRecord['queuedMessage']) : null;
  } catch {
    return undefined;
  }
}

/** A refusal retrying cannot fix (bad request, auth): kept locally, not resent forever. */
const isPermanentFailure = (status: number): boolean => status >= 400 && status < 500 && status !== 408 && status !== 429;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isEmptyDraft = (draft: DraftRecord): boolean => (
  draft.text === '' && draft.queuedMessage === null
);

function readMirror(): Map<string, DraftRecord> {
  try {
    const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return new Map();
    }

    const restored = new Map<string, DraftRecord>();
    for (const [scope, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      restored.set(scope, {
        text: typeof value.text === 'string' ? value.text : '',
        queuedMessage: isRecord(value.queuedMessage)
          ? (value.queuedMessage as DraftRecord['queuedMessage'])
          : null,
      });
    }
    return restored;
  } catch {
    return new Map();
  }
}

function writeMirror(): void {
  try {
    localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts)));
  } catch {
    // A full localStorage costs the first-paint restore, not the draft: the
    // server copy is authoritative and arrives on hydrate.
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHAT_DRAFTS_CHANGED_EVENT));
  }
}

function flushServerWrites(retrying = false): void {
  serverWriteTimer = null;
  const scopes = [...pendingScopes];
  pendingScopes.clear();

  for (const scope of scopes) {
    const generation = storeGeneration;
    const persist = async () => {
      if (generation !== storeGeneration) return;
      let draft = drafts.get(scope);
      try {
        if (retrying && draft?.queuedMessage && queueKey(draft.queuedMessage) === confirmedQueues.get(scope)) {
          // Only the text changed since the server confirmed this queue, and
          // it may have sent items from it meanwhile: keep the server's queue.
          const serverQueue = await readServerQueue(scope);
          if (serverQueue === undefined) throw new Error('Draft queue could not be re-read');
          if (generation !== storeGeneration) return;
          draft = { ...(drafts.get(scope) ?? EMPTY_DRAFT), queuedMessage: serverQueue };
          drafts.set(scope, draft);
          writeMirror();
          notifyListeners();
        }
        const response = !draft || isEmptyDraft(draft)
          ? await api.user.deleteDraft(scope)
          : await api.user.saveDraft(scope, { text: draft.text, queuedMessage: draft.queuedMessage });
        if (!response.ok && isPermanentFailure(response.status)) {
          console.error(`Chat draft refused (${response.status}); kept on this device only`);
          return;
        }
        if (!response.ok) throw new Error(`Draft save failed (${response.status})`);
        confirmedQueues.set(scope, queueKey(draft?.queuedMessage));
      } catch (error) {
        console.error('Failed to save chat draft:', error);
        // An undelivered draft (a queued message above all) must never be
        // dropped: keep the scope pending so the next hydrate cannot replace
        // it with the server's staler copy, and schedule another attempt.
        if (generation === storeGeneration) {
          pendingScopes.add(scope);
          if (serverWriteRetryTimer === null) {
            serverWriteRetryTimer = setTimeout(() => {
              serverWriteRetryTimer = null;
              flushServerWrites(true);
            }, SERVER_WRITE_RETRY_MS);
          }
        }
      }
    };

    // Queue actions persist immediately, but a slow request must finish before
    // a newer edit can reach the server and be overwritten by that old request.
    const previous = serverWrites.get(scope);
    const write = previous ? previous.then(persist) : persist();
    serverWrites.set(scope, write);
    void write.finally(() => {
      if (serverWrites.get(scope) === write) serverWrites.delete(scope);
    });
  }
}

function queueServerWrite(scope: string): void {
  pendingScopes.add(scope);

  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
  }
  serverWriteTimer = setTimeout(flushServerWrites, SERVER_WRITE_DEBOUNCE_MS);
}

function flushServerWritesNow(): void {
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  flushServerWrites();
}

function updateDraft(scope: string, update: Partial<DraftRecord>): void {
  const current = drafts.get(scope) ?? EMPTY_DRAFT;
  const next: DraftRecord = { ...current, ...update };

  if (next.text === current.text && next.queuedMessage === current.queuedMessage) {
    return;
  }

  const nextDrafts = new Map(drafts);
  if (isEmptyDraft(next)) {
    nextDrafts.delete(scope);
  } else {
    nextDrafts.set(scope, next);
  }
  drafts = nextDrafts;
  localRevisions.set(scope, (localRevisions.get(scope) ?? 0) + 1);

  writeMirror();
  queueServerWrite(scope);
  notifyListeners();
}

/** Reads one scope's composer text, synchronously, for the first render. */
export function readDraftText(scope: string): string {
  return drafts.get(scope)?.text ?? '';
}

export function writeDraftText(scope: string, text: string): void {
  updateDraft(scope, { text });
}

/** Reads the whole session queue, including legacy single-message drafts. */
export function readQueuedMessages(scope: string): StoredQueuedMessage[] {
  const stored = drafts.get(scope)?.queuedMessage;
  const items = stored && 'items' in stored ? stored.items : stored ? [stored] : [];
  return items.filter((item) => typeof item?.content === 'string').map((item, index) => ({
    ...item, id: item.id ?? `legacy-${index}`,
    attachments: item.attachments ?? item.images ?? [],
  }));
}

/** Compatibility reader for callers displaying the first pending message. */
export function readQueuedMessage(scope: string): StoredQueuedMessage | null {
  return readQueuedMessages(scope)[0] ?? null;
}

/** True when Stop or a failed turn suspended automatic sending. */
export function isQueuePaused(scope: string): boolean {
  const stored = drafts.get(scope)?.queuedMessage;
  return Boolean(stored && 'items' in stored && stored.paused);
}

/** Replaces queue contents without changing the composer's unsent text. */
export function replaceQueuedMessages(scope: string, items: StoredQueuedMessage[], paused = isQueuePaused(scope), forceId?: string): void {
  updateDraft(scope, { queuedMessage: items.length ? { items, paused, ...(forceId ? { forceId } : {}) } : null });
  flushServerWritesNow();
}

/** Appends a durable message; never replaces an earlier queued prompt. */
export function writeQueuedMessage(scope: string, message: StoredQueuedMessage): void {
  if (!message.content.trim() && !(message.attachments ?? message.images)?.length) return;
  replaceQueuedMessages(scope, [...readQueuedMessages(scope), { ...message, id: message.id ?? crypto.randomUUID() }]);
}

export function clearQueuedMessage(scope: string): void {
  replaceQueuedMessages(scope, []);
}

/** Subscribes to any draft change; returns the unsubscribe function. */
export function subscribeToChatDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Loads the server's drafts and adopts them as the source of truth.
 *
 * A scope the client has typed into since this page loaded is left alone: the
 * user is looking at that composer right now, and replacing its contents with a
 * staler server copy would delete what they are in the middle of writing.
 */
export async function hydrateChatDrafts(): Promise<void> {
  const revision = ++hydrationRevision;
  const revisionsAtRequest = new Map(localRevisions);
  const protectedScopes = new Set([...pendingScopes, ...serverWrites.keys()]);
  let serverDrafts: Array<{ scope?: unknown; text?: unknown; queuedMessage?: unknown }> = [];

  try {
    const response = await api.user.drafts();
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { drafts?: unknown };
    if (!Array.isArray(payload.drafts)) {
      return;
    }
    serverDrafts = payload.drafts as typeof serverDrafts;
  } catch (error) {
    // Keep the mirror: an offline load must still show what was typed here.
    console.error('Failed to load chat drafts:', error);
    return;
  }

  // Discard older snapshots only after a newer one has arrived. A slow
  // connection must still make progress while the next poll is outstanding.
  if (revision < lastHydratedRevision) return;
  lastHydratedRevision = revision;
  for (const scope of [...pendingScopes, ...serverWrites.keys(), ...localRevisions.keys()]) {
    if (pendingScopes.has(scope) || serverWrites.has(scope)
      || localRevisions.get(scope) !== revisionsAtRequest.get(scope)) protectedScopes.add(scope);
  }
  const merged = new Map<string, DraftRecord>();
  for (const draft of serverDrafts) {
    const scope = typeof draft.scope === 'string' ? draft.scope : '';
    if (!scope || protectedScopes.has(scope)) {
      continue;
    }

    const queuedMessage = isRecord(draft.queuedMessage)
      ? (draft.queuedMessage as DraftRecord['queuedMessage'])
      : null;
    merged.set(scope, {
      text: typeof draft.text === 'string' ? draft.text : '',
      queuedMessage,
    });
    confirmedQueues.set(scope, queueKey(queuedMessage));
  }

  // Keep edits made during this fetch or still being saved. Other missing
  // scopes were consumed or deleted remotely and leave the mirror as usual.
  for (const scope of protectedScopes) {
    const pending = drafts.get(scope);
    if (pending) {
      merged.set(scope, pending);
    }
  }

  drafts = merged;
  writeMirror();
  notifyListeners();
}

/** Drops every cached draft on sign-out, so the next user sees none of them. */
export function resetChatDrafts(): void {
  storeGeneration += 1;
  lastHydratedRevision = ++hydrationRevision;
  drafts = new Map();
  pendingScopes.clear();
  serverWrites.clear();
  localRevisions.clear();
  confirmedQueues.clear();
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  if (serverWriteRetryTimer !== null) {
    clearTimeout(serverWriteRetryTimer);
    serverWriteRetryTimer = null;
  }
  try {
    localStorage.removeItem(MIRROR_STORAGE_KEY);
  } catch {
    // The in-memory copy is already cleared, which is what readers use.
  }
  notifyListeners();
}

// Read at module load rather than on first use, because the composer's initial
// input value is a `useState` initializer that runs before any effect.
if (typeof localStorage !== 'undefined') {
  drafts = readMirror();
}
