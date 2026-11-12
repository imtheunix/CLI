import { Router, type Response } from 'express';

import { sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { buildSessionUpsertedEvent } from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import { getTurnPhase } from '@/modules/websocket/services/turn-phase.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  NormalizedMessage,
  RealtimeClientConnection,
  SessionUpsertedEvent,
} from '@/shared/types.js';

const DEFAULT_SNAPSHOT_MESSAGES = 50;
const MAX_SNAPSHOT_MESSAGES = 500;
const HEARTBEAT_MS = 15_000;

type ChatEventsDependencies = {
  fetchHistory: (
    sessionId: string,
    options: { limit: number },
  ) => Promise<{ messages: NormalizedMessage[] }>;
  buildSessionUpserted: (sessionId: string) => Promise<SessionUpsertedEvent | null>;
  hasBackgroundWork: (sessionId: string) => boolean;
};

const defaultDependencies: ChatEventsDependencies = {
  fetchHistory: (sessionId, options) => sessionsService.fetchHistory(sessionId, options),
  buildSessionUpserted: buildSessionUpsertedEvent,
  hasBackgroundWork: () => false,
};

export type ChatResyncSnapshot = {
  kind: 'chat_resync';
  sessionId: string;
  messages: NormalizedMessage[];
  events: NormalizedMessage[];
  sessions: SessionUpsertedEvent[];
  phase: ReturnType<typeof getTurnPhase>;
  isProcessing: boolean;
  lastSeq: number;
  timestamp: string;
};

/**
 * Builds the first frame an SSE client receives.
 *
 * It carries everything a reconnect needs without a page reload: the last N
 * persisted messages, the live run's buffered events after `lastSeq`, the
 * session-list deltas for the session's project, and the current turn phase.
 * The route attaches the connection before calling this, so events produced
 * while the snapshot is being read are buffered and sent right after it.
 */
export async function buildChatResyncSnapshot(
  sessionId: string,
  lastSeq: number,
  limit: number,
  dependencies: ChatEventsDependencies = defaultDependencies,
): Promise<ChatResyncSnapshot | null> {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    return null;
  }

  const history = await dependencies.fetchHistory(sessionId, { limit });
  const run = chatRunRegistry.getRun(sessionId);
  const projectSessions = session.project_path
    ? sessionsDb.getSessionsByProjectPath(session.project_path)
    : [];
  const sessions = (await Promise.all(
    projectSessions.map((row) => dependencies.buildSessionUpserted(row.session_id)),
  )).filter((event): event is SessionUpsertedEvent => event !== null);

  // A live event can already be in the persisted page (the transcript was
  // written between the run and this read). Keep the history copy and drop
  // the duplicate from the replay so a reconnect does not show it twice.
  const persistedIds = new Set(history.messages.map((message) => message.id));
  const events = chatRunRegistry
    .replayEvents(sessionId, lastSeq)
    .filter((event) => !persistedIds.has(event.id));

  return {
    kind: 'chat_resync',
    sessionId,
    messages: history.messages,
    events,
    sessions,
    phase: getTurnPhase(sessionId),
    isProcessing: chatRunRegistry.isProcessing(sessionId),
    lastSeq: run?.lastSeq ?? 0,
    timestamp: new Date().toISOString(),
  };
}

function writeEvent(res: Response, data: string): void {
  res.write(`data: ${data}\n\n`);
}

function parseNonNegativeInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

/**
 * GET /api/chat/events — the chat transport over Server-Sent Events.
 *
 * Additive to the websocket: the same auth, the same event kinds, plus a
 * `chat_resync` snapshot first so a reconnect never needs a page reload.
 * `sessionId` selects the conversation; `lastSeq` lets a reconnecting client
 * ask for only the live events it missed.
 */
export function createChatEventsRouter(
  overrides: Partial<ChatEventsDependencies> = {},
): Router {
  const dependencies: ChatEventsDependencies = { ...defaultDependencies, ...overrides };
  const router = Router();

  router.get('/events', async (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const lastSeq = parseNonNegativeInteger(req.query.lastSeq, 0, Number.MAX_SAFE_INTEGER);
    const limit = parseNonNegativeInteger(req.query.limit, DEFAULT_SNAPSHOT_MESSAGES, MAX_SNAPSHOT_MESSAGES);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    let closed = false;
    let ready = false;
    const pending: string[] = [];

    const connection: RealtimeClientConnection = {
      readyState: WS_OPEN_STATE,
      send(data: string) {
        if (closed) {
          return;
        }
        if (!ready) {
          pending.push(data);
          return;
        }
        writeEvent(res, data);
      },
    };

    const heartbeat = setInterval(() => {
      if (!closed) {
        res.write(': ping\n\n');
      }
    }, HEARTBEAT_MS);

    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      connection.readyState = 3;
      clearInterval(heartbeat);
      connectedClients.delete(connection);
      chatRunRegistry.detachConnection(connection);
    };

    req.on('close', cleanup);
    res.on('close', cleanup);

    // Attach before reading the snapshot: anything produced while history is
    // being fetched is buffered, then flushed after the snapshot. The seq
    // dedupe below drops events the snapshot already carries.
    connectedClients.add(connection);
    chatRunRegistry.attachConnection(
      sessionId,
      connection,
      chatRunRegistry.isProcessing(sessionId) || dependencies.hasBackgroundWork(sessionId),
    );

    try {
      const snapshot = await buildChatResyncSnapshot(sessionId, lastSeq, limit, dependencies);
      if (closed) {
        return;
      }
      if (!snapshot) {
        writeEvent(res, JSON.stringify({
          kind: 'protocol_error',
          code: 'SESSION_NOT_FOUND',
          error: `Session "${sessionId}" was not found.`,
          sessionId,
          timestamp: new Date().toISOString(),
        }));
        cleanup();
        res.end();
        return;
      }

      writeEvent(res, JSON.stringify(snapshot));
      ready = true;

      for (const data of pending.splice(0)) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        if (parsed && typeof parsed.seq === 'number' && parsed.seq <= snapshot.lastSeq) {
          continue;
        }
        writeEvent(res, data);
      }
    } catch (error) {
      if (closed) {
        return;
      }
      writeEvent(res, JSON.stringify({
        kind: 'protocol_error',
        code: 'RESYNC_FAILED',
        error: error instanceof Error ? error.message : String(error),
        sessionId,
        timestamp: new Date().toISOString(),
      }));
      cleanup();
      res.end();
    }
  });

  return router;
}
