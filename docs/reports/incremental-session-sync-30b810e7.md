# Incremental session sync without blocking UI startup (30b810e7)

## Root cause

`LabsProvider.syncRequests` ignored the persisted `scan_state.last_scanned_at`
cursor. It used an in-memory `newestAt` that reset on every process start, so
each restart re-queried the control room's full 30-day window (67,833 sessions
in the report), rewrote every transcript file, and re-upserted every session.
The projects routes also awaited `sessionSynchronizerService.synchronizeSessions()`
before reading the DB, so the sidebar could not render until that scan finished.

Secondary gaps: file synchronizers compared only `birthtime` to the cursor, so
transcripts modified while the app was down were never caught up; SQLite
synchronizers swallowed read failures and returned 0, which let the cursor
advance past sessions that were never indexed.

## Fix

- LABS now resumes from a persisted provider cursor (`.labs-sync-cursor` in its
  storage dir) combined with the global cursor, with a 60 s overlap for second
  truncation/clock skew. It deduplicates records by id, skips unchanged
  transcripts and rows, and only upserts sessions that actually changed.
  Failed scans reject; an unconfigured LABS (no token) stays a no-op so it
  cannot freeze every other provider's cursor.
- File discovery treats a file as changed when `max(birthtime, mtime)` is past
  the cursor, and rethrows non-ENOENT read errors.
- OpenCode/agy/zcode synchronizers rethrow read failures so a partial scan
  cannot advance the cursor or prune sessions. They also skip an upsert when
  the indexed row already matches the provider's metadata, so a row sitting on
  the cursor boundary cannot make the sidebar refresh loop.
- Projects routes serve the existing index immediately, run the incremental
  scan in the background, and broadcast `projects_refresh` only when a clean
  scan indexed something. Watchers are installed before the initial scan,
  which now runs in the background.

## Verification

- Server focused tests: 49 passed, 0 failed
  (`labs.provider`, `session-synchronizer-incremental`,
  `projects-with-sessions-fetch`, `session-synchronizer-coalescing`,
  `session-orphan-prune`, `sessions-watcher-debounce`, `opencode-sessions`,
  `agy-sessions`, `zcode-sessions`).
- Client focused tests: 8 passed, 0 failed
  (`projectsStateSelectionSync`, `useSpawnedSessions`).
- `npm run typecheck`: 4/4 projects clean.
- `oxlint` on every changed file: no errors (pre-existing React warnings only).
- No live full scan or real transcript content was read; all new tests use
  synthetic times and temp provider files.
