# Refute report: automatic post-completion review (Kimi job a9299142, commit 996d995b)

- Refute job: f563c204, fresh-context cross-family review by GLM Flash, 2026-11-10.
- Evidence branch `feature/cli-refute-automatic-review-stage-f563c204` (not for merge).
- Cherry-pick of 996d995b onto `origin/main` + `6ff58826` is **unchanged**: `diff <(git diff 736cb144 996d995b) <(git diff 6ff58826 4ff7c235)` is empty.

## Verdict: PASS

No safety boundary is violated; every reproduced defect is liveness-only and fail-safe. Details below.

## Counts

| Suite | Tests | Result |
| --- | --- | --- |
| `review.service.test.ts` + `refute.service.test.ts` + `review-gate.service.test.ts` | 12 | pass |
| `hub-wake.service.test.ts` | 27 | pass |
| `tjob.cli.test.ts` + `orchestrator-job-usage.test.ts` | 9 | pass |
| `orchestrator.test.ts` | 72 | pass |
| `effect-outbox.test.ts` | 21 | pass |
| `review-adversarial-refute.test.ts` (new adversarial probes) | 11 | pass |
| **Total** | **152** | **0 failures** |

Typecheck (`server/tsconfig.json`; full `npm run typecheck` also green) and `oxlint` (0 errors) pass. Total wall time ~3 min, no deploy.

## Safety boundaries

- **One automatic refute per producer completion** — holds. Duplicate `tjob done` is rejected (`markDone` state guard); duplicate ticks are suppressed by `inFlight`; a DB restart resumes the persisted step without re-refuting (probes 1, 8); an already-approved review is never re-refuted.
- **Different model family** — holds. `selectRefuteBackend` ignores same-family overrides and falls back cross-family even when `orchestrator.json` stores an identity mapping (probe 11).
- **No retry/review loop** — holds. Exactly one fix round (`review_round`); a second gate/defect failure escalates to the hub; escalations are terminal, the refutation is never re-launched after one (probes 4, 5).
- **Manual review compatibility** — holds. `tjob approve` works at any substep including `hub`; an approve during a parked refutation wins, produces exactly one approval and no review event (probe 2); legacy `review: true/false` config still maps; pre-review rows default to `review_step='none'` (probe 10).
- **Infra/config/migrations** — `riskyPaths` (incl. `migrations`, `k8s`, `.github`) force the hub; the refutation is plan-mode read-only; the gate is bounded (scoped checks, 20 min timeout).
- **Normal admission** — the refutation creates no job/branch/worktree and takes no producer slot; it launches one detached, session-correlated turn (`review_session_id` persisted, supersession checked).
- **Cancellation/supersession/restart/outbox** — cancel during a parked refutation sticks and never approves (probe 3); approve/cancel guards both directions (probe 9); effect-outbox suite green.
- **No secrets/session cross-access** — hub events carry reasons and `git diff --stat`, never the patch (shipped test asserts the patch marker is absent); the reviewer is scoped to the producer's worktree.
- **No approval/merge by the reviewer** — the reviewer's only output is a strict JSON verdict (prose/fencing/malformed shapes rejected); auto-approval goes through the same `approve` path as the hub.
- **Queue stays deployment-gated** — approve lands at `queued`; the queue leaves `review` rows alone.

## Findings (non-blocking)

1. **No timeout on the refutation turn** (reproduced, probe 6): a provider run that never settles parks the job at `review_step=refute` indefinitely — no hub wake, and the tick's `inFlight` entry is held. Fail-safe (nothing auto-approves; `tjob approve` and restart recovery still work; `tjob ls` shows `rv:refute`), but the hub is not told. Suggested fix: bound `refute()` (e.g. `Promise.race` with a config timeout that escalates to `needsHub`).
2. Post-crash relaunch: after a restart the in-memory run registry is empty, so the refutation turn is relaunched on the same session (`refute.service.ts:105`) — one extra bounded read-only turn per crash, one-refute semantics preserved in effect.
3. `fixOrEscalate` ignores `reopenWithMessage`'s `false` (producer busy / auth hold). The window is narrow (`isSessionBusy` was checked moments earlier) and the auth-hold path parks via the existing waiting machinery, but the fix message could be dropped silently.
4. `cancel` does not abort an in-flight refutation turn (only the producer session); the read-only reviewer runs to completion and its result is discarded — bounded waste, no safety impact.

## Adversarial probes

`server/modules/orchestrator/tests/review-adversarial-refute.test.ts`: duplicate done across restart, duplicate tick under a parked refutation, concurrent approve/cancel during refute, reviewer crash (login failure / exit code / no response), missing provider escalation, defects on the second completion, never-settling refutation, real `markDone`/`approve`/`cancel` guards, migration idempotence (init path re-run + legacy row), and malformed `orchestrator.json` review sections.
