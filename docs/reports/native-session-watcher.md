# Native session watcher events (7f38062e)

## Root cause

`server/modules/providers/services/sessions-watcher.service.ts` watched every provider
root with chokidar in polling mode:

```ts
usePolling: true,
interval: 6_000,
binaryInterval: 6_000,
```

A transcript change therefore waited for the next six-second poll before it reached
`onUpdate`, even though the rest of the path (per-file synchronizer, 1 s coalescer,
`session_upserted` broadcast) was already incremental.

## Change

- Removed `usePolling`, `interval` and `binaryInterval`. Chokidar 4.0.3 now uses native
  filesystem events (`fs.watch` on this platform). `atomic` keeps its native-event default
  (`true`), so editor-style write-temp-then-rename saves are normalized to a `change`.
- Kept `depth: 6`, `ignoreInitial: true`, `followSymlinks: false` and the existing ignored
  patterns. A provider root that is itself a symlink is resolved with `realpath` before
  watching; symlinks *inside* a provider tree are still not followed.
- The initial synchronizer scan now starts only after every watcher emits `ready` (bounded
  by a 5 s safety timeout). A file written during registration is therefore either present
  for the initial scan or delivered as a native event afterwards, instead of falling into
  the gap between the two.
- The watcher creates the root's parent, not the root itself. Chokidar can watch a missing
  root whose parent exists and emits `add`/`addDir` when the root appears.
- `closeSessionsWatcher` is now a shared in-flight promise: concurrent closes await the same
  close, a restart waits for an in-flight close before installing watchers, and pending
  `ready` waiters are cancelled so no startup timer survives shutdown. The existing
  generation guard still prevents a sync that resolves after close from queueing or
  broadcasting.
- `onUpdate` now checks the lifecycle guard before starting a per-file sync as well as after
  it.

No change was made to OpenCode streaming, composer/token-rate UI, merge queue/cancellation,
health alerts, or unrelated runtime files.

## Verification

Focused command:

```bash
npx tsx --tsconfig server/tsconfig.json --test \
  server/modules/providers/tests/sessions-watcher-native.test.ts \
  server/modules/providers/tests/sessions-watcher-debounce.test.ts
```

Result: **13 tests, 13 passed, 0 failed, 0 skipped** (8 new native-filesystem tests, 5
existing debounce/lifecycle tests). The new tests use real temporary directories and the
real chokidar watcher; only the provider synchronizer and websocket client set are stubbed.
No production session directory or external model is touched.

Measured update timing in the real-filesystem test: **1003 ms** from writing an existing
watched file to the `session_upserted` frame. That is the existing 1 s coalescer, not a
polling tick, and is well before the former 6 s poll. The test asserts `< 5000 ms` so it
fails if the old polling behavior returns.

Real checks covered:

1. A change to an existing watched file reaches the existing change handler and broadcasts
   one `session_upserted` frame; the full provider scan is not re-run.
2. A file that exists before registration is visible to the initial scan, and a file
   written while registration is in progress is not missed.
3. A watched root that is absent at construction is picked up when it appears.
4. Recursive changes in a nested project directory and an atomic temp-file rename are
   delivered without a full provider rescan.
5. A 20-write burst produces exactly one broadcast; per-file sync calls stay bounded by the
   number of writes.
6. Concurrent `closeSessionsWatcher` calls are idempotent, an in-flight sync that resolves
   after close does not broadcast, and a restart watches again.
7. A file deletion is not treated as a session update; offline deletion remains the
   synchronizer's prune path.
8. A symlinked provider root is watched through its real directory.

Also run:

- `npx tsc --noEmit -p server/tsconfig.json` — clean.
- `npx oxlint server/modules/providers/services/sessions-watcher.service.ts server/modules/providers/tests/sessions-watcher-native.test.ts` — clean.

The full workspace test gate was not run; CI runs it once after the job.

## Limitations

- Symlinks inside a provider tree are intentionally not followed (`followSymlinks: false`,
  unchanged). A provider root that is itself a symlink is supported via `realpath`.
- Native events are used on every platform. There is no polling fallback for filesystems
  that do not deliver native events (for example some network mounts); the previous global
  6 s polling was removed deliberately rather than kept as a hidden fallback.
- A provider root deleted *after* the watcher has attached is not reattached until restart.
  The initial scan/prune still handles offline deletion. This case was not part of the
  previous polling watcher's tested behavior either.
- The measured 1003 ms is watcher-to-broadcast timing in a temporary directory, not browser
  render latency or a claim of global UI responsiveness.
