# Graphify pilot — 2026-10-25

Job `1dc29182`, branch `job/graphify-local-project-maps-for-claude-g-1dc29182`; base HEAD `7374ea64e4900b4494155e0cf4fda031ae12ebec`. Setup/operation/removal: [local project maps](graphify.md). Raw offline measurements: [replay JSON](graphify-offline-replay-2026-10-25.json).

## Compatibility and safety evidence

Pinned Graphify 0.9.95 was installed from hash-checked wheels in a private Linux x86_64 / CPython 3.12 venv. Synthetic Java, TypeScript and Python extraction passed before indexing real code. The extractor received no provider credentials; its audit hook rejects network/subprocess operations, and it used only the explicit code API. No model sessions were launched for this pilot.

Seven Python integration tests cover language extraction and cross-file calls, nonexecution of indexed source, tracked/untracked selection, file/directory symlink exclusion, dirty edits/deletions/branch changes, separate commits/worktrees, concurrent preparation, byte budgets/truncation, failure/timeout/network rejection, and additive interactive guidance/removal. The indexed source sentinel did not execute.

The full backend suite passed: **826 passed, 1 skipped, 0 failed**. The orchestrator tests include preparation remaining in `preparing` until ready, followed by the same optional guidance for Claude, Codex and GLM. A timing regression found by the full suite was corrected by moving preparation before transition to `active`. `npm run build`, `npm run typecheck` and `npm run lint` passed; lint reports existing repository warnings. No checks or hooks were bypassed.

| Runtime | Environment evidence | Live model trial |
| --- | --- | --- |
| Claude Code 2.1.308 | Host executable available; shared host-shell query route; lifecycle test | Not run |
| Codex CLI 0.163.0 | Host executable available; this Codex job invoked the real wrapper; lifecycle test | No matched task trial |
| OpenCode 1.19.4 / GLM | Actual launcher is a host binary; runner inherits environment and uses `--dir`; lifecycle test | Not run |

These are host-shell/runner compatibility checks, not evidence that Claude or GLM completed a development task using the map. Other workstation/container environments remain unvalidated; installation must occur within their existing permissions.

## Deliberately selected real repository

Only this CLI worktree was scanned, with a temporary explicit policy selecting `src`, `server` and `scripts`. Neither tripam-api nor tripam-agents was scanned. The final staged-source snapshot selected **786 files**. Its identity was `db5ac1c6a98d301cc7a45b2ad53d9d832fc05a0b1b073ddccf23a3b6885237b0`; lock SHA-256 `9e1c7c871aa08c0bd7da3864e68de95d024d328ab345e268ef358d36c21b516a`. The identity includes this worktree, branch, base HEAD, policy, adapter and source hashes; a subsequent commit correctly makes it stale.

Final real preparation took **34,107 ms**, separate from model usage. Query `createJobsService` returned `server/modules/orchestrator/services/jobs.service.ts`, `L82`, with the correct worktree provenance, in **145 ms**. Output was **3,933 bytes** under the configured 4,000-byte budget, with `truncated: true` for omitted adjacent edges. Earlier preparation while source was being edited returned an error rather than publishing that changing snapshot. Timings are workstation observations, not general performance guarantees.

## Offline matched tool replay

The fixture uses deterministic base revision `2fb75d6d09f69f7246e4bfcfa12e9c31fdd94c3e`. Both routes inspect identical exact source. The local edit renames the TypeScript function `greet` to `hello`; the investigation identifies the Python `run` → `total` call across two files. Validation consists of static fixture assertions, not executing project code or proving a runtime bug fix.

Preparation took **263 ms**. The graph route added **439 bytes** of initial optional guidance:

| Task | Route | Exploration output bytes | Exact source reads | Task elapsed ms | Static outcome |
| --- | --- | ---: | ---: | ---: | --- |
| Local edit | ripgrep | 68 | 1 | 4 | Passed |
| Local edit | Graph query | 1,028 | 1 | 47 | Passed |
| Cross-file investigation | ripgrep | 105 | 2 | 4 | Passed |
| Cross-file investigation | Graph query | 1,298 | 2 | 46 | Passed |

Each route made one exploration request. On this tiny fixture, the graph route adds bytes and time and does not reduce exact source reads. This demonstrates repeatable compatibility, not efficiency. Whole-session input/output/cache tokens, provider credits and conversions, and model settings are **unknown/not applicable**, recorded as `null` in the raw artifact. No savings percentage is claimed. The existing tripam-agents trial's increased initial prompt text is consistent with treating guidance as overhead; it does not establish total-session savings.

## Activation and remaining work

The private workstation installation is present at `~/.local/share/cli-graphify/current`. No persistent repository opt-in entry or interactive assistant skill was installed; existing assistant instructions/auth are preserved. Real pilot config, graph artifacts and command metrics used temporary `/tmp/graphify-*-1dc29182*` paths outside Git.

Automatic tjob guidance requires normal deployment of this branch plus explicit repository enablement. The live CLI server was not restarted. Interactive shell use is available after setup and explicit opt-in. Defaults remain disabled. Future authorized matched agent trials must measure whole-session usage and actual final tests before any broader rollout; no extra autonomous jobs/accounts are required or started by this integration.
