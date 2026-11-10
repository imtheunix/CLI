import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { broadcastSessionUpsertedBatch } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';

type WatcherEventType = 'add' | 'change';

/**
 * Root directory configuration watched for session updates for each supported provider.
 * Used by initializeSessionsWatcher and tests.
 */
export const PROVIDER_WATCH_PATHS: Array<{ provider: LLMProvider; rootPath: string }> = [
  {
    provider: 'claude',
    rootPath: path.join(os.homedir(), '.claude', 'projects'),
  },
  {
    provider: 'cursor',
    rootPath: path.join(os.homedir(), '.cursor', 'projects'),
  },
  {
    provider: 'codex',
    rootPath: path.join(os.homedir(), '.codex', 'sessions'),
  },
  {
    provider: 'opencode',
    rootPath: path.join(os.homedir(), '.local', 'share', 'opencode'),
  },
  {
    provider: 'agy',
    rootPath: path.join(os.homedir(), '.gemini', 'antigravity-cli'),
  },
  {
    provider: 'zcode',
    rootPath: path.join(os.homedir(), '.zcode'),
  },
];

const WATCHER_IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/subagents/**',
  '**/tool-results/**',
  '**/*.tmp',
  '**/*.swp',
  '**/.DS_Store',
];

/**
 * Trailing debounce for the sidebar's session/project broadcast. A streaming
 * OpenCode job rewrites its database every few seconds, and each rewrite used
 * to fan out into its own broadcast; coalescing them keeps the event loop free
 * for the sidebar's own reads. The max wait bounds the delay under a constant
 * stream of changes.
 */
const PROJECTS_UPDATE_DEBOUNCE_MS = 1_000;
const PROJECTS_UPDATE_MAX_WAIT_MS = 2_000;

/**
 * A failed session id is retried on its own, with exponential backoff, so one
 * bad row (for example a database closed during shutdown) cannot suppress the
 * good ids in the same batch. The attempt cap keeps a permanently failing id
 * from spinning forever.
 */
const WATCHER_RETRY_BASE_DELAY_MS = 250;
const WATCHER_RETRY_MAX_DELAY_MS = 2_000;
const WATCHER_MAX_RETRY_ATTEMPTS = 5;

const watchers: FSWatcher[] = [];

type PendingWatcherUpdate = {
  providers: Set<LLMProvider>;
  changeTypes: Set<WatcherEventType>;
  /**
   * Provider-native session ids reported by the synchronizers. They are
   * translated back to app-facing session rows at flush time, because the
   * transcript file names on disk only ever contain provider ids.
   */
  updatedSessionIds: Set<string>;
};

let pendingWatcherUpdate: PendingWatcherUpdate | null = null;
let pendingWatcherUpdateStartedAt: number | null = null;
let pendingWatcherFlushTimer: ReturnType<typeof setTimeout> | null = null;
let watcherRefreshInFlight = false;
let watcherRescheduleAfterRefresh = false;

/**
 * Lifecycle guard. `closeSessionsWatcher` bumps the generation and marks the
 * watcher closed; every async continuation captures the generation it started
 * under and refuses to queue, schedule or broadcast once it no longer matches.
 * Without this, a `synchronizeProviderFile` await that resolves after close
 * would recreate pending state and emit a frame after shutdown.
 */
let watcherClosed = false;
let watcherGeneration = 0;

let pendingWatcherRetryIds: Set<string> | null = null;
let pendingWatcherRetryAttempt = 0;
let pendingWatcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
let watcherRetryRescheduleAfterRefresh = false;

function isWatcherActive(generation: number): boolean {
  return !watcherClosed && generation === watcherGeneration;
}

function clearPendingWatcherRetryTimer(): void {
  if (pendingWatcherRetryTimer) {
    clearTimeout(pendingWatcherRetryTimer);
    pendingWatcherRetryTimer = null;
  }
}

/**
 * Filters watcher events to provider-specific session artifact file types.
 * Used by onUpdate and unit tests to verify provider-specific artifact matching.
 */
export function isWatcherTargetFile(provider: LLMProvider, filePath: string): boolean {
  if (provider === 'opencode') {
    return path.basename(filePath) === 'opencode.db';
  }

  if (provider === 'agy') {
    return path.basename(filePath) === 'conversation_summaries.db';
  }

  if (provider === 'zcode') {
    return path.basename(filePath) === 'db.sqlite' || filePath.endsWith('.jsonl');
  }

  return filePath.endsWith('.jsonl');
}

function clearPendingWatcherFlushTimer(): void {
  if (pendingWatcherFlushTimer) {
    clearTimeout(pendingWatcherFlushTimer);
    pendingWatcherFlushTimer = null;
  }
}

function schedulePendingWatcherFlush(): void {
  if (watcherClosed || !pendingWatcherUpdate) {
    return;
  }

  const now = Date.now();
  if (pendingWatcherUpdateStartedAt === null) {
    pendingWatcherUpdateStartedAt = now;
  }

  const elapsed = now - pendingWatcherUpdateStartedAt;
  const remainingMaxWait = Math.max(0, PROJECTS_UPDATE_MAX_WAIT_MS - elapsed);
  const delay = Math.min(PROJECTS_UPDATE_DEBOUNCE_MS, remainingMaxWait);

  clearPendingWatcherFlushTimer();
  pendingWatcherFlushTimer = setTimeout(() => {
    void flushPendingWatcherUpdate();
  }, delay);
}

function queuePendingWatcherUpdate(
  eventType: WatcherEventType,
  provider: LLMProvider,
  updatedSessionId: string | null
): void {
  if (watcherClosed) {
    return;
  }

  if (!pendingWatcherUpdate) {
    pendingWatcherUpdate = {
      providers: new Set<LLMProvider>(),
      changeTypes: new Set<WatcherEventType>(),
      updatedSessionIds: new Set<string>(),
    };
  }

  pendingWatcherUpdate.providers.add(provider);
  pendingWatcherUpdate.changeTypes.add(eventType);
  if (updatedSessionId) {
    pendingWatcherUpdate.updatedSessionIds.add(updatedSessionId);

    // A fresh event for an id already waiting on retry supersedes the retry:
    // the normal flush will broadcast it once, so drop it from the retry set
    // to avoid a duplicate frame.
    if (pendingWatcherRetryIds?.delete(updatedSessionId) && pendingWatcherRetryIds.size === 0) {
      pendingWatcherRetryIds = null;
      pendingWatcherRetryAttempt = 0;
      clearPendingWatcherRetryTimer();
    }
  }

  schedulePendingWatcherFlush();
}

/**
 * Broadcasts each id on its own so a throw while resolving one session cannot
 * abort the rest of the batch. Returns the ids that failed and are eligible
 * for retry.
 */
async function broadcastWatcherSessionIds(
  sessionIds: Iterable<string>,
  generation: number
): Promise<Set<string>> {
  const failedSessionIds = new Set<string>();

  for (const sessionId of sessionIds) {
    if (!isWatcherActive(generation)) {
      return failedSessionIds;
    }

    try {
      // Per-session deltas instead of full project snapshots: an upsert of one
      // session can never clobber unrelated client state, so the frontend needs
      // no "suppress updates while a run is active" protection logic.
      await broadcastSessionUpsertedBatch([sessionId]);
    } catch (error) {
      failedSessionIds.add(sessionId);
      const message = error instanceof Error ? error.message : String(error);
      console.error('Session watcher refresh failed while broadcasting session_upserted', {
        sessionId,
        error: message,
      });
    }
  }

  return failedSessionIds;
}

function armPendingWatcherRetryTimer(): void {
  if (watcherClosed || !pendingWatcherRetryIds || pendingWatcherRetryIds.size === 0) {
    return;
  }

  const attempt = Math.max(1, pendingWatcherRetryAttempt);
  const delay = Math.min(
    WATCHER_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    WATCHER_RETRY_MAX_DELAY_MS
  );

  clearPendingWatcherRetryTimer();
  pendingWatcherRetryTimer = setTimeout(() => {
    void flushPendingWatcherRetry();
  }, delay);
}

function schedulePendingWatcherRetry(failedSessionIds: Set<string>): void {
  if (watcherClosed) {
    return;
  }

  if (!pendingWatcherRetryIds) {
    pendingWatcherRetryIds = new Set<string>();
  }
  for (const sessionId of failedSessionIds) {
    pendingWatcherRetryIds.add(sessionId);
  }

  pendingWatcherRetryAttempt += 1;
  if (pendingWatcherRetryAttempt > WATCHER_MAX_RETRY_ATTEMPTS) {
    console.error('Session watcher refresh retry limit reached; dropping pending session updates', {
      sessionIds: [...pendingWatcherRetryIds],
      attempts: WATCHER_MAX_RETRY_ATTEMPTS,
    });
    pendingWatcherRetryIds = null;
    pendingWatcherRetryAttempt = 0;
    clearPendingWatcherRetryTimer();
    return;
  }

  armPendingWatcherRetryTimer();
}

async function flushPendingWatcherRetry(): Promise<void> {
  clearPendingWatcherRetryTimer();

  if (watcherClosed || !pendingWatcherRetryIds || pendingWatcherRetryIds.size === 0) {
    return;
  }

  if (watcherRefreshInFlight) {
    // Let the in-flight refresh re-arm the retry when it finishes instead of
    // polling the timer while it runs.
    watcherRetryRescheduleAfterRefresh = true;
    return;
  }

  const generation = watcherGeneration;
  const retrySessionIds = pendingWatcherRetryIds;
  pendingWatcherRetryIds = null;
  watcherRefreshInFlight = true;

  let failedSessionIds = new Set<string>();
  try {
    failedSessionIds = await broadcastWatcherSessionIds(retrySessionIds, generation);
  } finally {
    if (generation === watcherGeneration) {
      watcherRefreshInFlight = false;
    }

    if (isWatcherActive(generation)) {
      if (failedSessionIds.size > 0) {
        schedulePendingWatcherRetry(failedSessionIds);
      } else {
        pendingWatcherRetryAttempt = 0;
      }

      if (watcherRetryRescheduleAfterRefresh) {
        watcherRetryRescheduleAfterRefresh = false;
        armPendingWatcherRetryTimer();
      }

      if (pendingWatcherUpdate || watcherRescheduleAfterRefresh) {
        watcherRescheduleAfterRefresh = false;
        schedulePendingWatcherFlush();
      }
    }
  }
}

async function flushPendingWatcherUpdate(): Promise<void> {
  clearPendingWatcherFlushTimer();

  if (watcherClosed || !pendingWatcherUpdate) {
    return;
  }

  if (watcherRefreshInFlight) {
    watcherRescheduleAfterRefresh = true;
    return;
  }

  const generation = watcherGeneration;
  const queuedUpdate = pendingWatcherUpdate;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = true;

  let failedSessionIds = new Set<string>();
  try {
    failedSessionIds = await broadcastWatcherSessionIds(queuedUpdate.updatedSessionIds, generation);
  } finally {
    if (generation === watcherGeneration) {
      watcherRefreshInFlight = false;
    }

    if (isWatcherActive(generation)) {
      if (failedSessionIds.size > 0) {
        schedulePendingWatcherRetry(failedSessionIds);
      }

      if (watcherRetryRescheduleAfterRefresh) {
        watcherRetryRescheduleAfterRefresh = false;
        armPendingWatcherRetryTimer();
      }

      if (pendingWatcherUpdate || watcherRescheduleAfterRefresh) {
        watcherRescheduleAfterRefresh = false;
        schedulePendingWatcherFlush();
      }
    }
  }
}

/**
 * Handles file watcher updates and triggers provider file-level synchronization.
 */
async function onUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): Promise<void> {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

  const generation = watcherGeneration;

  try {
    const result = await sessionSynchronizerService.synchronizeProviderFile(provider, filePath);
    if (!isWatcherActive(generation) || !result.indexed) {
      return;
    }

    console.log(`Session synchronization triggered by ${eventType} event for provider "${provider}"`, {
      filePath,
      sessionId: result.sessionId,
    });
    queuePendingWatcherUpdate(eventType, provider, result.sessionId);
  } catch (error) {
    if (!isWatcherActive(generation)) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`Session watcher sync failed for provider "${provider}"`, {
      eventType,
      filePath,
      error: message,
    });
  }
}

/**
 * Starts provider filesystem watchers and performs initial DB synchronization.
 */
export async function initializeSessionsWatcher(): Promise<void> {
  watcherClosed = false;
  watcherGeneration += 1;
  const generation = watcherGeneration;

  clearPendingWatcherFlushTimer();
  clearPendingWatcherRetryTimer();
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  pendingWatcherRetryIds = null;
  pendingWatcherRetryAttempt = 0;
  watcherRefreshInFlight = false;
  watcherRescheduleAfterRefresh = false;
  watcherRetryRescheduleAfterRefresh = false;

  console.log('Setting up session watchers');

  const initialSync = await sessionSynchronizerService.synchronizeSessions();
  if (!isWatcherActive(generation)) {
    return;
  }

  console.log('Initial session synchronization complete', {
    processedByProvider: initialSync.processedByProvider,
    prunedOrphans: initialSync.prunedOrphans,
    failures: initialSync.failures,
  });

  for (const { provider, rootPath } of PROVIDER_WATCH_PATHS) {
    if (!isWatcherActive(generation)) {
      return;
    }

    try {
      await fsPromises.mkdir(rootPath, { recursive: true });

      const watcher = chokidar.watch(rootPath, {
        ignored: WATCHER_IGNORED_PATTERNS,
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        depth: 6,
        usePolling: true,
        interval: 6_000,
        binaryInterval: 6_000,
      });

      watcher
        .on('add', (filePath: string) => {
          void onUpdate('add', filePath, provider);
        })
        .on('change', (filePath: string) => {
          void onUpdate('change', filePath, provider);
        })
        .on('error', (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Session watcher error for provider "${provider}"`, { error: message });
        });

      watchers.push(watcher);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to initialize session watcher for provider "${provider}"`, {
        rootPath,
        error: message,
      });
    }
  }
}

/**
 * Stops all active provider session watchers.
 */
export async function closeSessionsWatcher(): Promise<void> {
  watcherClosed = true;
  watcherGeneration += 1;

  clearPendingWatcherFlushTimer();
  clearPendingWatcherRetryTimer();
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  pendingWatcherRetryIds = null;
  pendingWatcherRetryAttempt = 0;
  watcherRefreshInFlight = false;
  watcherRescheduleAfterRefresh = false;
  watcherRetryRescheduleAfterRefresh = false;

  await Promise.all(
    watchers.map(async (watcher) => {
      try {
        await watcher.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to close session watcher', { error: message });
      }
    })
  );
  watchers.length = 0;
}
