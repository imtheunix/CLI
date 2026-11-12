# Full CLI test gate in clean Forgejo CI

The full CLI gate ran green on the clean `archsv` Forgejo runner.

- Run: `1244` (run number `4` in the repo)
- Link: http://127.0.0.1:3000/imtheunix/CLI/actions/runs/4
- Commit: `f8e25461b2d778e9f013d50405428f29e6f766f5` (`ci(cli): stub LABS control room for clean runner tests`)
- Branch: `feature/cli-full-test-gate-runs-in-clean-forgejo-9dd184ab`
- Status: success, 2026-11-11T20:06:59Z → 2026-11-11T20:11:48Z (289 s)

## Rebased onto current `main`

This branch was rebased with ordinary `git` onto `origin/main` at
`06c27ec7` (no conflicts; the workflow and this report are new files).

- Rebased workflow head: `f965f8d381985bf81d1d3708f932016026f82120`
- The restored `.github/workflows/cli-tests.yml` is byte-for-byte identical
  to the one that produced the green run-4 result above (`f8e25461`).
- The rebased head has **not** run CI yet: the queue/CI gate must run it
  before anyone treats the rebased branch as green.

## Gate

The workflow runs exactly the required gate on a clean runner:

```bash
env -u CLAUDE_CLI_PATH -u CLAUDE_CODE_EXECUTABLE -u CLAUDE_CODE_EXECPATH \
  npm run typecheck && \
  npm run lint && \
  npm test && \
  NODE_ENV=test npm run test:client
```

`CLI_HUB_EVENTS_LOG` points at a per-run temp file. Node comes from `.nvmrc`
(`v22`). The runner has no `en_US` locale, so the gate pins `LANG=C`,
`LC_ALL=C`, and `TZ=UTC`.

## Results

| Suite | Tests | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Server (`npm test`, node:test) | 1288 | 1287 | 0 | 1 |
| Client (`NODE_ENV=test npm run test:client`, vitest) | 831 | 831 | 0 | 0 |
| **Total** | **2119** | **2118** | **0** | **1** |

Client: 125 test files, all passed. Typecheck and lint passed before the tests.

## What the clean runner needed

1. `env -u GITHUB_TOKEN npm ci` — Forgejo forwards `GITHUB_TOKEN`, and the
   `@vscode/ripgrep` postinstall got a 401 from GitHub when it was present.
2. `$HOME/Tribeira` and `$HOME/.config/cli/labs.token` — the shell picker and
   LabsProvider expect a workstation home and a Labs token.
3. A local LABS control-room stub on `127.0.0.1:18190` returning `[]`, with
   `LABS_CONTROL_URL` pointing at it — without it the LabsProvider tests and
   the session-sync test fail on a clean runner.
4. `LANG=C`, `LC_ALL=C`, `TZ=UTC` — the runner only has `C`, `C.utf8`,
   `POSIX`, and `pt_BR.utf8`; `LANG=C` gives the expected `3,200` grouping.

## Reproduce

Push to the branch; the `CLI Tests` workflow runs the gate on `archsv`.
