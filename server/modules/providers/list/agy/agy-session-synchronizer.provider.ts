import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import {
  getAgyDatabasePath,
  normalizeSessionName,
  readOptionalString,
} from '@/shared/utils.js';

type AgyConversationSummaryRow = {
  conversation_id: string;
  title: string | null;
  preview: string | null;
  workspace_uris: string | null;
  last_modified_time: string | null;
  last_user_input_time: string | null;
  status: string | null;
  parent_conversation_id: string | null;
  killed: number | null;
};

type SynchronizeRowsResult = {
  processed: number;
  firstSessionId: string | null;
};

type AgyChildSessionRow = {
  id: string;
};

function parseAgyTimestamp(value: unknown): string {
  if (typeof value === 'string' && value.trim() && !value.startsWith('0001')) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()) && date.getTime() > 0) {
      return date.toISOString();
    }
  }
  return new Date().toISOString();
}

/**
 * Session indexer for Antigravity / Gemini CLI's SQLite-backed conversation summaries store.
 * Used by AgyProvider and session synchronizer service to index native agy conversation summaries into the sessions database.
 */
export class AgySessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'agy' as const;
  private childSessionsReconciled = false;

  /**
   * Scans agy's shared conversation_summaries.db and upserts active sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const result = this.synchronizeRows(since, undefined, !this.childSessionsReconciled);
    return result.processed;
  }

  /**
   * Handles watcher changes for conversation_summaries.db.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (path.basename(filePath) !== 'conversation_summaries.db') {
      return null;
    }

    const result = this.synchronizeRows(undefined, 1);
    return result.firstSessionId;
  }

  private synchronizeRows(
    since?: Date,
    limit?: number,
    pruneChildSessions = false,
  ): SynchronizeRowsResult {
    const dbPath = getAgyDatabasePath();
    if (!fsSync.existsSync(dbPath)) {
      return { processed: 0, firstSessionId: null };
    }

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      if (pruneChildSessions) {
        this.pruneChildSessions(db);
        this.childSessionsReconciled = true;
      }

      const sinceIso = since ? since.toISOString() : null;
      const limitClause = limit ? 'LIMIT ?' : '';
      const params = limit ? [sinceIso, sinceIso, limit] : [sinceIso, sinceIso];
      const rows = db.prepare(`
        SELECT
          s.conversation_id AS conversation_id,
          s.title AS title,
          s.preview AS preview,
          s.workspace_uris AS workspace_uris,
          s.last_modified_time AS last_modified_time,
          s.last_user_input_time AS last_user_input_time,
          s.status AS status,
          s.parent_conversation_id AS parent_conversation_id,
          s.killed AS killed
        FROM conversation_summaries s
        WHERE (s.parent_conversation_id IS NULL OR s.parent_conversation_id = '')
          AND (? IS NULL OR datetime(s.last_modified_time) >= datetime(?))
        ORDER BY datetime(s.last_modified_time) DESC, s.conversation_id DESC
        ${limitClause}
      `).all(...params) as AgyConversationSummaryRow[];

      let processed = 0;
      let firstSessionId: string | null = null;
      for (const row of rows) {
        const indexedSessionId = this.upsertSession(row);
        if (!indexedSessionId) {
          continue;
        }

        if (!firstSessionId) {
          firstSessionId = indexedSessionId;
        }
        processed += 1;
      }

      return { processed, firstSessionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[AgySessionSynchronizer] Failed to synchronize sessions:', message);
      // Rethrow so the orchestrator records a failed scan and does not advance
      // the persisted cursor past sessions this scan never indexed.
      throw error;
    } finally {
      db.close();
    }
  }

  private pruneChildSessions(db: Database.Database): void {
    const childSessions = db.prepare(`
      SELECT conversation_id AS id
      FROM conversation_summaries
      WHERE parent_conversation_id IS NOT NULL AND parent_conversation_id != ''
    `).all() as AgyChildSessionRow[];

    for (const childSession of childSessions) {
      sessionsDb.deleteSessionByProviderSessionId(childSession.id, this.provider);
    }
  }

  private extractProjectPath(workspaceUrisRaw: string | null): string | null {
    if (!workspaceUrisRaw) {
      return null;
    }
    try {
      const uris = JSON.parse(workspaceUrisRaw);
      if (Array.isArray(uris) && uris.length > 0 && typeof uris[0] === 'string' && uris[0].trim()) {
        const firstUri = uris[0].trim();
        if (firstUri.startsWith('file://')) {
          return fileURLToPath(firstUri);
        }
        return firstUri;
      }
    } catch {
      return null;
    }
    return null;
  }

  private upsertSession(row: AgyConversationSummaryRow): string | null {
    const sessionId = readOptionalString(row.conversation_id);
    const projectPath = this.extractProjectPath(row.workspace_uris);
    if (!sessionId || !projectPath) {
      return null;
    }

    const fallbackTitle = 'Untitled agy Session';
    const pendingAppSession = sessionsDb.getSessionByProviderSessionId(sessionId)
      ?? sessionsDb.getSessionById(sessionId)
      ?? sessionsDb.findLatestPendingAppSession(this.provider, projectPath);
    if (pendingAppSession && !pendingAppSession.provider_session_id) {
      sessionsDb.assignProviderSessionId(pendingAppSession.session_id, sessionId);
    }

    const existingSession = sessionsDb.getSessionByProviderSessionId(sessionId)
      ?? sessionsDb.getSessionById(sessionId);
    const existingName = existingSession?.custom_name;

    let nextName: string | undefined;
    if (existingName && existingName !== fallbackTitle) {
      nextName = existingName;
    } else {
      nextName = readOptionalString(row.title) || readOptionalString(row.preview);
    }

    const timeUpdated = parseAgyTimestamp(row.last_modified_time);
    const timeCreated = parseAgyTimestamp(
      row.last_user_input_time && !row.last_user_input_time.startsWith('0001')
        ? row.last_user_input_time
        : row.last_modified_time
    );

    // agy stores conversations in shared database files; jsonl_path must stay null
    // so individual app session deletion does not destroy shared database stores.
    return sessionsDb.createSession(
      sessionId,
      this.provider,
      projectPath,
      normalizeSessionName(nextName, fallbackTitle),
      timeCreated,
      timeUpdated,
      null,
    );
  }
}
