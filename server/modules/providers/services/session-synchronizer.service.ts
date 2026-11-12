import fs from 'node:fs';
import path from 'node:path';

import { scanStateDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';

type SessionSynchronizeResult = {
  processedByProvider: Record<LLMProvider, number>;
  /** Indexed sessions dropped because their transcript file no longer exists. */
  prunedOrphans: number;
  failures: string[];
};

type TranscriptProbe = 'present' | 'absent' | 'unknown';

/**
 * A directory listing validated against the directory's own identity and
 * timestamps. `entries` is only trusted while the directory still has the same
 * device/inode and modification/change times.
 */
type DirectoryManifest = {
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  capturedAtMs: number;
  entries: Set<string>;
};

/**
 * Directory manifests survive between syncs so an unchanged project costs one
 * `stat` per directory instead of one `access` per indexed transcript. The
 * cache is bounded to directories that still have indexed rows.
 */
const directoryManifests = new Map<string, DirectoryManifest>();

/**
 * Filesystems with coarse timestamps can report the same directory mtime for
 * changes made within the same tick. A manifest captured this close to the
 * directory's last change is re-listed rather than trusted.
 */
const COARSE_TIMESTAMP_WINDOW_MS = 2_000;

const probeTranscript = async (target: string): Promise<TranscriptProbe> => {
  try {
    await fs.promises.access(target);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown';
  }
};

const isManifestTrustworthy = (manifest: DirectoryManifest, stats: fs.BigIntStats): boolean => {
  if (
    manifest.dev !== stats.dev ||
    manifest.ino !== stats.ino ||
    manifest.mtimeNs !== stats.mtimeNs ||
    manifest.ctimeNs !== stats.ctimeNs
  ) {
    return false;
  }

  const mtimeMs = Number(stats.mtimeNs / 1_000_000n);
  return mtimeMs < manifest.capturedAtMs - COARSE_TIMESTAMP_WINDOW_MS;
};

/**
 * Returns the current entries of `directory`, reusing a previously validated
 * listing when the directory identity and timestamps are unchanged.
 *
 * Returns `null` when the directory cannot be statted or listed. Callers must
 * treat that as "unknown" and keep every row in the directory: an unmounted,
 * denied or replaced root must never be read as "all transcripts were deleted".
 */
const getDirectoryManifest = async (directory: string): Promise<DirectoryManifest | null> => {
  let stats: fs.BigIntStats;
  try {
    stats = await fs.promises.stat(directory, { bigint: true });
  } catch {
    directoryManifests.delete(directory);
    return null;
  }

  if (!stats.isDirectory()) {
    directoryManifests.delete(directory);
    return null;
  }

  const cached = directoryManifests.get(directory);
  if (cached && isManifestTrustworthy(cached, stats)) {
    return cached;
  }

  let names: string[];
  try {
    names = await fs.promises.readdir(directory);
  } catch {
    directoryManifests.delete(directory);
    return null;
  }

  const manifest: DirectoryManifest = {
    dev: stats.dev,
    ino: stats.ino,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    capturedAtMs: Date.now(),
    entries: new Set(names),
  };
  directoryManifests.set(directory, manifest);
  return manifest;
};

/**
 * Removes indexed sessions whose transcript file has disappeared from disk.
 *
 * Nothing else deletes these rows: the synchronizers only ever upsert, and the
 * watcher reacts to `add`/`change` but not `unlink`. A transcript removed by
 * hand — or written by a test run that pointed at the real `~/.claude` — left a
 * permanent sidebar entry that opened an empty "Untitled" session.
 *
 * Existence is established from a validated directory listing, not from a
 * per-row probe. A row is only dropped when its containing directory was
 * listed successfully, the listing does not contain the transcript, and a
 * final direct probe confirms the file is absent. A missing, unreadable or
 * replaced directory keeps every row in it.
 */
const pruneOrphanedSessions = async (): Promise<number> => {
  const rowsByDirectory = new Map<string, Array<{ sessionId: string; jsonlPath: string }>>();

  for (const { session_id: sessionId, jsonl_path: jsonlPath } of sessionsDb.getSessionsWithTranscriptPath()) {
    const directory = path.dirname(jsonlPath);
    const rows = rowsByDirectory.get(directory);
    if (rows) {
      rows.push({ sessionId, jsonlPath });
    } else {
      rowsByDirectory.set(directory, [{ sessionId, jsonlPath }]);
    }
  }

  let pruned = 0;

  for (const [directory, rows] of rowsByDirectory) {
    const manifest = await getDirectoryManifest(directory);
    if (!manifest) {
      continue;
    }

    for (const { sessionId, jsonlPath } of rows) {
      if (manifest.entries.has(path.basename(jsonlPath))) {
        continue;
      }

      // The listing says the file is gone. Revalidate the candidate directly so
      // a stale listing or a file recreated after the listing cannot delete a
      // live row. Only a confirmed absence is allowed to prune.
      if ((await probeTranscript(jsonlPath)) !== 'absent') {
        continue;
      }

      if (sessionsDb.deleteSessionById(sessionId)) {
        pruned += 1;
      }
    }
  }

  for (const directory of directoryManifests.keys()) {
    if (!rowsByDirectory.has(directory)) {
      directoryManifests.delete(directory);
    }
  }

  return pruned;
};

/**
 * The scan that every `synchronizeSessions()` caller shares while it runs.
 *
 * Opening the UI fires `/api/projects` and `/api/projects/archived` at once,
 * and each used to start its own full provider scan from the same
 * `last_scanned_at` cursor: identical work over identical transcripts,
 * contending for the same synchronous SQLite writes and doubling how long the
 * sidebar sits on its loading screen. Callers that arrive while a scan is
 * already running now await that scan instead of starting another.
 */
let inFlightSynchronization: Promise<SessionSynchronizeResult> | null = null;

/**
 * Runs all provider synchronizers and updates scan_state.last_scanned_at.
 */
async function runSessionSynchronization(): Promise<SessionSynchronizeResult> {
  const lastScanAt = scanStateDb.getLastScannedAt();
  const scanBoundary = new Date();
  const processedByProvider: Record<LLMProvider, number> = {
    claude: 0,
    codex: 0,
    cursor: 0,
    opencode: 0,
    agy: 0,
    labs: 0,
    zcode: 0,
  };
  const failures: string[] = [];

  const results = await Promise.allSettled(
    providerRegistry.listProviders().map(async (provider) => ({
      provider: provider.id,
      processed: await provider.sessionSynchronizer.synchronize(lastScanAt ?? undefined),
    }))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      processedByProvider[result.value.provider] = result.value.processed;
      continue;
    }

    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    failures.push(reason);
  }

  // Pruning is skipped after a partial sync: a provider that just failed may
  // not have re-indexed transcripts it would otherwise have re-created.
  const prunedOrphans = failures.length === 0 ? await pruneOrphanedSessions() : 0;

  if (failures.length === 0) {
    scanStateDb.updateLastScannedAt(scanBoundary);
  } else {
    console.warn(
      `[Sessions] Skipping scan_state cursor advance because ${failures.length} provider sync(s) failed.`,
    );
  }

  return {
    processedByProvider,
    prunedOrphans,
    failures,
  };
}

/**
 * Orchestrates provider-specific session indexers and indexed-session lifecycle operations.
 */
export const sessionSynchronizerService = {
  /**
   * Scans every provider for new or changed sessions, coalescing concurrent
   * callers onto a single scan.
   */
  async synchronizeSessions(): Promise<SessionSynchronizeResult> {
    if (inFlightSynchronization) {
      return inFlightSynchronization;
    }

    inFlightSynchronization = runSessionSynchronization().finally(() => {
      inFlightSynchronization = null;
    });

    return inFlightSynchronization;
  },

  /**
   * Indexes one provider artifact file without running a full provider rescan.
   */
  async synchronizeProviderFile(
    provider: LLMProvider,
    filePath: string
  ): Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string | null }> {
    const resolvedProvider = providerRegistry.resolveProvider(provider);
    const sessionId = await resolvedProvider.sessionSynchronizer.synchronizeFile(filePath);
    return {
      provider,
      indexed: Boolean(sessionId),
      sessionId,
    };
  },
};
