# Job 74375287 — stop event-loop blocking in detached turns and Zcode login

## Cause
- `isTurnAlive` ran `spawnSync('systemctl --user is-active')` on every 50 ms `tailLogFile` poll, so each live turn blocked the event loop dozens of times per second.
- `zcode-home.apiKeyLogin` ran `execFileSync` with a 60 s timeout on the turn's create path.

## Changes
- `detached-runner.service.ts`
  - `isTurnAlive` is now async and probes with `execFile` (2 s timeout). Concurrent probes for one unit share a single in-flight promise.
  - `tailLogFile` accepts `boolean | Promise<boolean>` liveness, tracks its poll timer and clears it on completion/error; final drain and EOF/unit-exit behavior unchanged.
  - `spawnDetachedTurn` is async (awaits the post-`systemd-run` liveness check); `prepareDetachedExec().complete` is async.
  - Propagated through `agy.provider`, `codex-runtime.provider`, `reattachActiveTurns`, `retireDetachedSessionTurns`.
- `zcode-home.ts`
  - `prepareZcodeHome` is async; `apiKeyLogin` uses `execFile` with the same env (`HOME`), 60 s timeout and warn-on-failure behavior.
  - Per-home in-flight login promise dedupes concurrent preparations of the same shadow home.
  - Propagated through `zcode.provider` and `zcode-probe`.

## Tests (focused only)
- New `detached-turns/tests/detached-liveness.test.ts` (3): slow stubbed `systemctl` keeps the event loop responsive and dedupes concurrent probes; `tailLogFile` stops polling on completion and on liveness errors, drains final output.
- New `providers/tests/zcode-home.test.ts` (2): slow stubbed login keeps the event loop responsive; concurrent preparations share one login.
- Updated existing detached-turn/restart tests for the async API.
- Results: 44/44 pass (liveness, detached restart, zcode-home, zcode provider, agy provider, codex runtime); `claude-codex-restart` 14/14 pass. `tsc --noEmit -p server/tsconfig.json` clean; targeted oxlint clean (one pre-existing import-order warning in `claude-codex-restart.test.ts`).

## Residual risk
- `getUnitExitCode` still uses `spawnSync` but only runs once at turn finalization, not in the hot poll.
- `execFile` for the login pipes output instead of ignoring it; a very chatty login script could hit the default 1 MB buffer and be treated as a failed login (shared link kept).
