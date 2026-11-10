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

## Job 751ce082 — merge fix: async OpenCode turn test doubles

### Finding (production defect, not a stub-only contract)
The merge of 62f97f9d made `spawnDetachedTurn` async, but the OpenCode runtime
still called it without `await` and then read `turnExecution.promise`. The
value was a `Promise<DetachedTurnExecution>`, so `.promise` was `undefined` and
every OpenCode turn failed at `opencode-runtime.provider.js:330` with
`Cannot destructure property 'exitCode' of '(intermediate value)' as it is undefined`.
The failing tests use real fake CLI executables, not module mocks, so there was
no test double to update: the defect was in the live consumer.

### Change
- `opencode-runtime.provider.js`: `await spawnDetachedTurn(...)`, matching the
  already-async `agy.provider` call site. The async production API and full
  tail/abort/completion behavior are preserved.
- `opencode-runtime.provider.test.js`: one contract regression that runs a fake
  CLI exiting with code 3 and asserts the runtime awaits the execution, rejects
  with `exited with code 3`, and sends `complete.exitCode === 3`. A missing
  `await` fails this test with the original destructuring error.

### Verification
- `opencode-runtime.provider.test.js`, `opencode-effort.test.ts`,
  `runtime-cancellation.test.ts`, `detached-liveness.test.ts`,
  `detached-turns-restart.test.ts`: 20/20 pass.
- `tsc --noEmit -p server/tsconfig.json`: clean.

### CI follow-up — zcode dispatch probe isolation
The full gate then failed 3 `zcode-dispatch-probe` tests. Root cause: the
async `prepareZcodeHome` now awaits `apiKeyLogin`, whose test guard only checks
`NODE_ENV === 'test'`. `npm test` runs under `node --test` (which sets
`NODE_TEST_CONTEXT`, not `NODE_ENV`), so on a workstation with real ZCode
credentials the probe ran the real ~3 s login for every probe and the 5 s
`eventually` timeout expired. The test now sets `NODE_ENV=test` for its
duration (the probe is `explicit: true`, so the fake binary still runs) and
restores it. Verified with a deliberately slow login script: 3/3 pass; zcode
dispatch/home/provider suites 19/19 pass; server typecheck clean.
