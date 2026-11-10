import fsSync from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import {
  getZcodeDatabasePath,
  normalizeSessionName,
  readOptionalString,
} from '@/shared/utils.js';

type ZcodeSessionRow = {
  id: string;
  title: string | null;
  directory: string | null;
  path: string | null;
  time_created: number;
  time_updated: number;
  parent_id: string | null;
  time_deleted: number | null;
};

type SynchronizeRowsResult = {
  processed: number;
  firstSessionId: string | null;
};

type ZcodeChildSessionRow = {
  id: string;
};

function parseZcodeTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return new Date(parsed).toISOString();
    }
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()) && date.getTime() > 0) {
      return date.toISOString();
    }
  }
  return new Date().toISOString();
}

/**
 * Session indexer for ZCode's SQLite-backed session store (`~/.zcode/cli/db/db.sqlite`).
 * Used by ZcodeProvider and session synchronizer service to index native ZCode sessions into the sessions database.
 */
export class ZcodeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'zcode' as const;
  private childSessionsReconciled = false;

  /**
   * Scans zcode's shared db.sqlite and upserts active sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const result = this.synchronizeRows(since, undefined, !this.childSessionsReconciled);
    return result.processed;
  }

  /**
   * Handles watcher changes for db.sqlite.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (path.basename(filePath) !== 'db.sqlite') {
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
    const dbPath = getZcodeDatabasePath();
    if (!fsSync.existsSync(dbPath)) {
      return { processed: 0, firstSessionId: null };
    }

    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });

      if (pruneChildSessions) {
        this.pruneChildSessions(db);
        this.childSessionsReconciled = true;
      }

      const sinceMs = since ? since.getTime() : null;
      const limitClause = limit ? 'LIMIT ?' : '';
      const params = limit ? [sinceMs, sinceMs, limit] : [sinceMs, sinceMs];
      const rows = db.prepare(`
        SELECT
          s.id AS id,
          s.title AS title,
          s.directory AS directory,
          s.path AS path,
          s.time_created AS time_created,
          s.time_updated AS time_updated,
          s.parent_id AS parent_id,
          s.time_deleted AS time_deleted
        FROM session s
        WHERE (s.parent_id IS NULL OR s.parent_id = '')
          AND s.time_deleted IS NULL
          AND (? IS NULL OR s.time_updated >= ?)
        ORDER BY s.time_updated DESC, s.id DESC
        ${limitClause}
      `).all(...params) as ZcodeSessionRow[];

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
      console.warn('[ZcodeSessionSynchronizer] Failed to synchronize sessions:', message);
      // Rethrow so the orchestrator records a failed scan and does not advance
      // the persisted cursor past sessions this scan never indexed.
      throw error;
    } finally {
      db?.close();
    }
  }

  private pruneChildSessions(db: Database.Database): void {
    const childSessions = db.prepare(`
      SELECT id
      FROM session
      WHERE parent_id IS NOT NULL AND parent_id != ''
    `).all() as ZcodeChildSessionRow[];

    for (const childSession of childSessions) {
      sessionsDb.deleteSessionByProviderSessionId(childSession.id, this.provider);
    }
  }

  private upsertSession(row: ZcodeSessionRow): string | null {
    const sessionId = readOptionalString(row.id);
    const projectPath = readOptionalString(row.directory) || readOptionalString(row.path);
    if (!sessionId || !projectPath) {
      return null;
    }

    const fallbackTitle = 'Untitled ZCode Session';
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
      nextName = readOptionalString(row.title);
    }

    const timeUpdated = parseZcodeTimestamp(row.time_updated);
    const timeCreated = parseZcodeTimestamp(row.time_created);

    // zcode stores conversations in SQLite db; jsonl_path must stay null
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
