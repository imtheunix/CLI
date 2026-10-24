import { sessionsDb } from '@/modules/database/index.js';
import { findSpawningProviderSessionId } from '@/shared/spawn-lineage.js';
import type { SpawnLineageDependencies } from '@/shared/spawn-lineage.js';

/**
 * Resolves the app session that spawned a provider session the synchronizers
 * are about to index, for the file-backed providers (Claude, Codex, Cursor).
 *
 * Used by each synchronizer right before it creates a NEW row for a
 * discovered transcript: while the transcript is being written its process is
 * alive, so its environment can still name the Claude session whose shell
 * started it. The caller records the returned id with
 * `sessionsDb.setSessionSpawnedBy` after the row exists. Returns null — never
 * throws — for a session the index already knows (its lineage stands as
 * recorded), a session with no per-session transcript file (OpenCode shares
 * one sqlite file), an unknown parent, or any detection error: discovery must
 * not be blocked by lineage detection.
 */
export function findSpawnParentForNewSession(
  input: {
    providerSessionId: string;
    transcriptPath: string | null;
  },
  deps?: SpawnLineageDependencies,
): string | null {
  try {
    if (!input.transcriptPath) {
      return null;
    }

    // Only a row being created carries the spawn moment; an already-indexed
    // session must keep whatever lineage it was first discovered with.
    if (sessionsDb.getSessionByProviderSessionId(input.providerSessionId)) {
      return null;
    }

    const parentProviderSessionId = findSpawningProviderSessionId(
      input.transcriptPath,
      input.providerSessionId,
      deps,
    );
    if (!parentProviderSessionId) {
      return null;
    }

    const parent = sessionsDb.getSessionByProviderSessionId(parentProviderSessionId);
    if (!parent || parent.session_id === input.providerSessionId) {
      return null;
    }

    return parent.session_id;
  } catch {
    return null;
  }
}
