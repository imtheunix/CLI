import { getConnection } from '@/modules/database/connection.js';

/**
 * One chat scope's unsent state: the text still in the composer, plus the
 * message queued behind an in-flight turn. Both are optional — a scope can
 * hold only a draft, only a queued message, or both.
 */
export type SessionDraftRecord = {
  scope: string;
  text: string;
  queuedMessage: unknown | null;
  updatedAt: string;
};

type DraftRow = {
  draft_scope: string;
  draft_text: string;
  queued_message: string | null;
  updated_at: string;
};

/** A server-owned queued turn together with the exact stored value used to claim it once. */
export type QueuedSessionMessageRecord = {
  userId: number;
  sessionId: string;
  queuedMessage: unknown;
  claimToken: string;
};

type QueuedMessageRow = {
  user_id: number;
  draft_scope: string;
  queued_message: string;
};

/** A queued message that no longer parses is treated as absent, not fatal. */
function parseQueuedMessage(raw: string | null): unknown | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toRecord(row: DraftRow): SessionDraftRecord {
  return {
    scope: row.draft_scope,
    text: row.draft_text,
    queuedMessage: parseQueuedMessage(row.queued_message),
    updatedAt: row.updated_at,
  };
}

export const sessionDraftsDb = {
  /**
   * Returns every draft the user has, newest first.
   *
   * The client pulls the whole set once per load: drafts are short strings, and
   * having them all up front means switching sessions restores a draft written
   * on another device without a round trip.
   */
  getDrafts(userId: number): SessionDraftRecord[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT draft_scope, draft_text, queued_message, updated_at
         FROM session_drafts
         WHERE user_id = ?
         ORDER BY datetime(updated_at) DESC`
      )
      .all(userId) as DraftRow[];

    return rows.map(toRecord);
  },

  /** Lists persisted queued turns whose scopes are real chat sessions. */
  listQueuedMessages(): QueuedSessionMessageRecord[] {
    const rows = getConnection()
      .prepare(
        `SELECT drafts.user_id, drafts.draft_scope, drafts.queued_message
         FROM session_drafts AS drafts
         INNER JOIN sessions ON sessions.session_id = drafts.draft_scope
         WHERE drafts.queued_message IS NOT NULL`
      )
      .all() as QueuedMessageRow[];

    return rows.map((row) => ({
      userId: row.user_id,
      sessionId: row.draft_scope,
      queuedMessage: parseQueuedMessage(row.queued_message),
      claimToken: row.queued_message,
    }));
  },

  /** Persists an explicit socket delivery request so it survives a restart before dispatch. */
  requestQueuedDelivery(userId: number, scope: string, messageId: string, allowInterrupt: boolean): QueuedSessionMessageRecord | null {
    const draft = this.getDrafts(userId).find((item) => item.scope === scope);
    const queue = draft?.queuedMessage as { items?: Array<{ id?: string }> } | undefined;
    if (!draft || !queue?.items?.some((item) => item.id === messageId)) return null;
    this.saveDraft(userId, scope, {
      text: draft.text,
      queuedMessage: { ...queue, paused: false, forceId: messageId, forceInterrupt: allowInterrupt },
    });
    return this.listQueuedMessages().find((item) => item.userId === userId && item.sessionId === scope) ?? null;
  },

  /** Atomically consumes one item; the claim token prevents an edited queue from being sent. */
  claimQueuedMessage(candidate: QueuedSessionMessageRecord): boolean {
    const stored = candidate.queuedMessage as { items?: unknown[]; forceId?: string; paused?: boolean } | null;
    let remaining: string | null = null;
    if (Array.isArray(stored?.items)) {
      const index = stored.forceId ? stored.items.findIndex((item) => (item as { id?: string })?.id === stored.forceId) : 0;
      if (index < 0) return false;
      const items = stored.items.filter((_, position) => position !== index);
      remaining = items.length ? JSON.stringify({ items, paused: false }) : null;
    }
    const db = getConnection();
    return db.transaction(() => {
      const result = db.prepare(
        `UPDATE session_drafts SET queued_message = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND draft_scope = ? AND queued_message = ?`
      ).run(remaining, candidate.userId, candidate.sessionId, candidate.claimToken);
      if (!result.changes) return false;
      const items = Array.isArray(stored?.items) ? stored.items : [stored];
      const selected = items.find((item, index) => stored?.forceId ? (item as { id?: string })?.id === stored.forceId : index === 0) as { id?: string } | undefined;
      if (selected?.id) db.prepare('INSERT OR IGNORE INTO queued_message_receipts (user_id, session_id, message_id) VALUES (?, ?, ?)')
        .run(candidate.userId, candidate.sessionId, selected.id);
      return true;
    })();
  },

  /** Restores a failed reservation without overwriting edits made since the claim. */
  restoreQueuedMessage(candidate: QueuedSessionMessageRecord): void {
    const stored = candidate.queuedMessage as { items?: unknown[]; forceId?: string } | null;
    let expected: string | null = null;
    if (Array.isArray(stored?.items)) {
      const index = stored.forceId ? stored.items.findIndex((item) => (item as { id?: string })?.id === stored.forceId) : 0;
      const items = stored.items.filter((_, position) => position !== index);
      expected = items.length ? JSON.stringify({ items, paused: false }) : null;
    }
    const originalItems = Array.isArray(stored?.items) ? stored.items : [stored];
    const selected = originalItems.find((item, index) => stored?.forceId ? (item as { id?: string })?.id === stored.forceId : index === 0) as { id?: string } | undefined;
    if (!selected) return;
    const db = getConnection();
    db.transaction(() => {
      const current = this.getDrafts(candidate.userId).find((draft) => draft.scope === candidate.sessionId);
      if (selected.id) db.prepare('DELETE FROM queued_message_receipts WHERE user_id = ? AND session_id = ? AND message_id = ?')
        .run(candidate.userId, candidate.sessionId, selected.id);
      const rawCurrent = current?.queuedMessage == null ? null : JSON.stringify(current.queuedMessage);
      if (rawCurrent === expected) {
        this.saveDraft(candidate.userId, candidate.sessionId, { text: current?.text ?? '', queuedMessage: JSON.parse(candidate.claimToken) });
      } else {
        // Preserve edits to the other messages while returning the unsent item.
        const queue = current?.queuedMessage as { id?: string; items?: Array<{ id?: string }>; paused?: boolean } | undefined;
        const currentItems = Array.isArray(queue?.items) ? queue.items : queue ? [queue] : [];
        const items = selected.id && currentItems.some((item) => item.id === selected.id) ? currentItems : [selected, ...currentItems];
        this.saveDraft(candidate.userId, candidate.sessionId, { text: current?.text ?? '', queuedMessage: { items, paused: queue?.paused ?? false } });
      }
    })();
  },

  /** Stops automatic consumption while retaining every pending item, including across restarts. */
  pauseQueue(scope: string): void {
    const db = getConnection();
    db.transaction(() => {
      const rows = db.prepare('SELECT user_id, queued_message FROM session_drafts WHERE draft_scope = ? AND queued_message IS NOT NULL').all(scope) as { user_id: number; queued_message: string }[];
      for (const row of rows) {
        const stored = parseQueuedMessage(row.queued_message) as { items?: unknown[] } | null;
        if (!stored) continue;
        const items = Array.isArray(stored.items) ? stored.items : [stored];
        db.prepare('UPDATE session_drafts SET queued_message = ? WHERE user_id = ? AND draft_scope = ?')
          .run(JSON.stringify({ items, paused: true }), row.user_id, scope);
      }
    })();
  },

  /** Removes the placeholder row left after its last queued turn is claimed. */
  deleteEmptyDraft(userId: number, scope: string): void {
    getConnection()
      .prepare(
        `DELETE FROM session_drafts
         WHERE user_id = ? AND draft_scope = ? AND draft_text = '' AND queued_message IS NULL`
      )
      .run(userId, scope);
  },

  /**
   * Writes one scope's draft, or deletes the row when nothing is left to keep.
   *
   * Deleting on empty is what stops the table growing a permanent row for every
   * session the user ever opened and typed a character into.
   */
  saveDraft(
    userId: number,
    scope: string,
    draft: { text: string; queuedMessage: unknown | null }
  ): void {
    const db = getConnection();

    const stored = draft.queuedMessage as { items?: Array<{ id?: string }>; id?: string; forceId?: string; forceInterrupt?: boolean } | null;
    if (stored) {
      const receipt = db.prepare('SELECT 1 FROM queued_message_receipts WHERE user_id = ? AND session_id = ? AND message_id = ?');
      const items = (Array.isArray(stored.items) ? stored.items : [stored])
        .filter((item) => !item.id || !receipt.get(userId, scope, item.id));
      if (Array.isArray(stored.items) || items.length === 0) {
        const next = { ...stored, items };
        if (!items.some((item) => item.id === next.forceId)) {
          delete next.forceId;
          delete next.forceInterrupt;
        }
        draft = { ...draft, queuedMessage: items.length ? next : null };
      }
    }
    if (!draft.text && draft.queuedMessage === null) {
      db.prepare('DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .run(userId, scope);
      return;
    }

    db.prepare(
      `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, draft_scope) DO UPDATE SET
         draft_text = excluded.draft_text,
         queued_message = excluded.queued_message,
         updated_at = CURRENT_TIMESTAMP`
    ).run(
      userId,
      scope,
      draft.text,
      draft.queuedMessage === null ? null : JSON.stringify(draft.queuedMessage)
    );
  },

  deleteDraft(userId: number, scope: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
      .run(userId, scope);
  },
};
