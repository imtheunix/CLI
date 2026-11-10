# Orchestrator: coding jobs over Claude, GPT, GLM, ZCode and Gemini Flash

The orchestrating session (any chat in CLI) hands coding tasks to `tjob new`. Each task becomes a **job**: a real CLI session, named `Claude · …`, `GPT · …`, `GLM Flash · …` `GLM · …` (the full GLM model) or `Gemini Flash · …` in the Sessions tab, running in its own git worktree (`~/Tribeira/.jobs/<repo>/<id>`, branch `job/<slug>-<id>`). Open it and talk to it like any other session.

## Balancing

| Backend | Runtime | Model (default · on request) | Cap |
|---|---|---|---|
| `claude` | Claude Agent SDK | `claude-opus-5-5` (high) | 2 |
| `codex` (GPT) | Codex | `gpt-6.1-sol` (medium) | 2 |
| `agy` | agy CLI | `gemini-3.8-flash-medium` (medium effort) | 4 |
| `glm` | OpenCode, Z.ai Coding Plan | `zai-coding-plan/glm-5.3-flash` · `zai-coding-plan/glm-5.3` | 3 |
| `zcode` | ZCode CLI | `GLM-5.3-Flash` · `GLM-5.3` | 3 |

- A job without a backend goes to whichever backend is working on the fewest jobs (under its cap); ties go to the cheapest (GLM, then GPT, then Claude).
- A job that asks for a backend gets it while it is under its cap, and GLM when it is not.
- During GLM's peak hours (below), a job without a backend goes to GLM only when Claude and GPT have no room (`glmPeakHours.avoid`, on by default).
- With no room, the job waits (`queued`) and starts when a slot frees, oldest first.
- A job holds its slot while it is being set up and while its agent works **or waits for an answer**. It frees it when it is **finished**: its agent ran `tjob done <id>` (code complete and committed), or the person told the session they do not want the job anymore (its agent runs `tjob cancel <id>`; `tjob resume` brings it back). Pressing Stop is **not** finishing: it is a change of direction or more context coming, and the job keeps its slot.

The Codex runtime runs `$CODEX_PATH` when set, else the first `codex` on the server's PATH (outside `node_modules/.bin`), else the binary bundled with `@openai/codex-sdk`; it logs which one and its version on the first Codex turn. The bundled copy lags and can refuse newer models such as `gpt-6.1-sol`.

### GLM: Flash by default, the full model on request

The Coding Plan's week is 60,000 credits. Per 10,000 tokens, GLM-5.3 costs 6.9 (input), 1.7 (cached) and 24 (output); GLM-5.3-Flash 2.3, 0.56 and 8, about a third. A long OpenCode session re-reads its whole context every step (one job: 267 steps, 37M cached tokens, ~3,700 credits), and most jobs do not need the full model, so GLM jobs run Flash unless `tjob new --model glm-5.3` asks for the full one. A job keeps its model on every later turn: CI/CD queue messages, `tjob resume`, and the "continue" after a restart. A job that asked for another backend's model and was sent to GLM (its backend at its cap) runs GLM's default.

**Peak hours:** Z.ai reportedly charges more on weekdays 14:00-18:00 UTC+8 (03:00-07:00 in São Paulo, `glmPeakHours` in the config). In that window, jobs without a backend go to Claude or GPT while they have room.

### GLM quota fallback

When a GLM or ZCode turn reports Z.ai's quota exhaustion errors (5-hour limit code 1308 or weekly/monthly limit code 1310), the backend is marked quota-exhausted until its reported reset. Z.ai's unqualified reset times are interpreted as UTC+8; missing, invalid or past reset times use a one-hour cooldown. Ordinary HTTP 429/rate-limit errors do not trigger this fallback. The cooldown persists across server restarts.

While exhausted, jobs requested on GLM or ZCode (including cap overflow) use agy with Gemini 3.8 Flash. A quota-stopped job keeps its worktree and branch and gets a new agy conversation. Its prompt includes the original task and an instruction to inspect `git log`, `git status` and the diff before continuing. The old session remains available. Agy's cap is respected; when full, continuations wait in the queue. `tjob ls` shows the actual backend/model, the fallback, and the cooldown.

Set `"glmQuotaFallback": "wait"` to queue GLM/ZCode work until reset instead. The default is `"agy"`. Override `"backends": { "agy": { "cap": 4 } }` to change its cap. Explicit `tjob new --backend agy` or `tjob new --backend zcode` works at any time; agy is otherwise used for quota fallback. ZCode runs `GLM-5.3-Flash` by default (never full GLM-5.3 unless explicitly requested). Set `"glmProvider": "zcode"` in `orchestrator.json` to route default `glm` backend jobs through ZCode rather than OpenCode (default is `"opencode"`).

**ZCode plan selection.** Each ZCode turn chooses its plan explicitly: it writes `providerId`, `modelId` and `options.reasoningLevel` to `~/.zcode/v2/provider_config.json` (under a lock, until ZCode reports its selection) and tries the plans in order: Weekend Build (`account:zai-offpeak-idle-plan`), Start Plan (`account:zai-start-plan`, Flash only), then Coding Plan (`account:zai-individual-coding-plan`). A turn's output is held until ZCode's first `session.updated` report names the requested provider and model. If ZCode reports anything else, the turn is stopped before the model request. A plan answering with a 1310/1308 quota error or a 429 is skipped too. In either case the reason goes to the transcript (`provider_fallback`) and to `~/.cloudcli/zcode/provider-state.json` with a cooldown: until the quota reset, 10 minutes after a 429, or 6 hours when the plan is unavailable headless. The Coding Plan is always tried last, so its quota errors still reach the fallback above. When the last plan reports a model other than the one requested, its output is dropped and the turn fails. ZCode never silently runs full GLM-5.3 in place of Flash.

*Finding, 2026-11-06 (ZCode 0.17.1):* headless `zcode -p` cannot use the Start Plan or the Weekend Build. Standalone ZCode (no desktop host) treats only `individual-coding-plan` providers as entitled, and its token refresh rejects other modes. Start Plan requests also need the desktop host's captcha headers (provider code 3007 otherwise). An unentitled default, or one without a supported `reasoningLevel`, is silently replaced by the first visible model: Coding Plan full GLM-5.3. The chain above detects this and moves on, so either plan will be used automatically if ZCode starts honoring it. To switch models interactively, use `/model` in the desktop app; the `zcode` TUI needs `@zcode/tui`, which ships only in ZCode's single-file build (it is not on npm).

### Usage limits and logins (every backend)

A turn is classified per backend from its provider's own failure signals only: its error events, Claude's SDK error code (`rate_limit`, `authentication_failed`) and the start of the provider's error message or the `message` of its JSON error object; never assistant prose or tool output, so a failing test that prints the limit text stays other. Classes: `usage_limit` (with the reset the provider states: Claude `resets 7:30pm (America/Sao_Paulo)`, Codex `try again at 10:47 AM` / `Nov 4th, 2026 8:22 AM` in local time, Z.ai's UTC+8 reset), `auth_required` (Claude `Please run /login`, Zcode `project_token_login_failed`, agy `not logged into Antigravity`, Codex logged out) or other. The class, resume time and armed recovery are stored on the job (`failure_class`, `resume_at`, `limit_recovery`), so a restart keeps them; `tjob ls` shows `! usage limit, resumes 14:05` or `! login needed`. GLM/ZCode quota keeps its fallback above.

- **usage_limit with a reset:** one recovery per (job, turn, failure): the same failed turn handled again changes nothing, only a new turn failing again advances; at the reset plus up to 90 s of jitter the same session gets `Continue where you left off.` A reset already past is refused, the chain gives up 24 h after its first failure (`firstFailedAt`, checked when arming and again before delivering or probing); both wake the hub (`waiting`).
- **usage_limit without a reset:** back off 15, 30, 60 min, then wait for the hub.
- **auth_required:** the job waits and wakes the hub once; every 10 min the backend's login check runs and the job resumes when it passes, at most three times in a row.

A turn that ends without a limit or login failure clears the job's recovery. Reimplemented after T3 Code's UsageLimitRecoveryWorker (MIT).

### Codex out of quota: hand over to GLM Flash (`codexQuotaFallback`)

The person, 2026-11-07: "when Terra is out of quota replace it with GLM flash". Set `"codexQuotaFallback": "glm-flash"` in `orchestrator.json` (default `"wait"`: today's wait-and-resume above).

When a Codex job's turn ends on `usage_limit`, the wait is armed first as usual; then, with `glm-flash`, the job is handed over only if it is still `active` with no CI/CD step (never in review or the merge queue), a GLM slot is free (GLM's cap, no GLM quota cooldown) and the ZCode login probe passes. Otherwise the armed wait stays. The handover keeps the job id, worktree and branch; the job's backend becomes `glm` on its Flash model (`zai-coding-plan/glm-5.3-flash`, or `GLM-5.3-Flash` on ZCode) in a new session. The first GLM turn gets the original job prompt plus a handover note: the Codex agent's last message, `git log` of the branch since its base, `git status --short`, and `Continue where the previous agent stopped.`

The first GLM turn starts on the handover's own ZCode probe (no second probe in between). Its full prompt is saved with the handover (`pendingPrompt`) until that turn starts: if it does not (a login wait, a restart), the resume sends the saved prompt in place of the generic continue line, with any other message (e.g. from CI/CD) appended to it.

Each handover is recorded on the job (`backend_history`: from/to backend and model, the previous session, reason `quota`, the stated `resetAt`, the failed turn's recovery key) and runs once per failed turn (that key, also the outbox `handover` effect's key). `tjob ls` shows `codex->glm (quota)`; the job view's `usageByBackend` lists each backend's session and usage, so Codex and GLM usage stay attributed to their own backend.

### Configuration

Caps, models and the rest can be overridden in `~/.config/cli/orchestrator.json` (see `orchestrator-config.service.ts`), with no rebuild. For example, switching GLM jobs to ZCode, and setting GLM even in its peak hours:

```json
{
  "glmProvider": "zcode",
  "glmPeakHours": { "avoid": false }
}
```

A backend's `models` maps the models a job may ask for to the label of its session (`GLM Flash`); setting it replaces the whole list. The default `model` is always allowed.

Automatic review is configured under `review` (the legacy boolean still maps to `review.enabled`):

```json
{
  "review": {
    "enabled": true,
    "refuteCap": 2,
    "refuteTimeoutMs": 1200000,
    "maxLines": 400,
    "protectedRepos": [],
    "riskyPaths": ["infra", "auth", "secrets", "ci", "migrations", "k8s", ".forgejo", ".github"],
    "refuteBackendFor": { "morph": "glm", "glm": "morph", "zcode": "morph", "claude": "glm", "codex": "glm", "agy": "glm" }
  }
}
```

## Automatic review and CI/CD queue

Optional local symbol/dependency maps for Claude, Codex, GLM and agy jobs are documented in [Graphify project maps](graphify.md). They are disabled by default and use one bounded shell interface without changing model selection or job completion rules.

With review enabled, `tjob done` first persists `review_step=gate`. The gate resolves the same repository checks as the merge queue, keeps typechecking project-aware, scopes lint to changed files, and runs changed tests plus tests that import changed sources. Next, one read-only refutation runs in the existing worktree on the other model family, with its own `refuteCap` and no job, branch or producer-pool slot. Its strict JSON verdict counts only defects with a reproduced probe and output. `refuteTimeoutMs` is at most 20 minutes by configuration as well as by default; timeout aborts and archives the reviewer session and parks the job at the hub with the exact timeout reason, never approving or retrying. Cancelling the job also aborts that reviewer and discards its late result. Gate red or reproduced defects return to the producer for one fix round; if that reopen is refused (busy or authentication hold), the job is restored to review and the hub receives the fix evidence instead. A second failure goes to the hub. Persisted steps resume after restart: a re-attached refutation is awaited, and a terminal refute session's persisted transcript is reused rather than prompted again. `tjob ls` shows `rv:<step>` and `tjob show` includes the verdict and risk.

The policy auto-approves through the ordinary `tjob approve` path only when the gate and refutation pass, the diff stays inside paths named in the brief (skipped when none are named), has fewer than `maxLines` changed lines, touches no risky path and is not in a protected repository. Approval emits a batched FYI; all other outcomes emit a `review` decision with gate/verdict and `git diff --stat`, never the full patch. With review disabled, `tjob done` queues directly.

After approval, a stacked job, one whose `<base>` is another job's branch, lands where that job lands. Merging it into the parent's branch would not count as merged: it waits in `queued` while the parent is on its way, moves to the parent's base once the parent is merged, and is blocked when the parent was cancelled or failed. Job 88328da6 was marked merged into the branch of cancelled job f8a49612 and never reached main. `tjob ls` marks the wait as `! waiting for base <id> (<state>)`; when the base sits at review for more than 30 minutes, the hub is woken once for the stacked job (two queue deadlocks on 2026-11-07). Per repository, one job at a time goes through:

1. **rebase** onto the latest `origin/<base>`. Conflicts are resolved by Gemini 3.8 Flash (`agy`); what it cannot settle goes back to the job's agent.
2. **check**: a light gate, never the full suite (the user, 2026-11-03: Forgejo CI is the only full gate; a red main is fixed afterwards). In order: the configured command (`checks` in the config), the repository's `scripts/merge-gate.sh`, then per stack `npm run typecheck && npm run lint` (whichever exist, never `test`/`check`), `mvn -q -o test-compile` (online if offline fails), `cargo check --all-targets --quiet`, `python -m pytest --collect-only -q` (through `scripts/hermes-env.sh` when present, plus `ruff check` when ruff is configured), and `scripts/check.sh` only when nothing lighter applies. At most `maxConcurrentChecks` (default 1) checks run at once on the workstation, under `nice -n 10`; the others wait in `check`.
3. **push** to `<base>`. It does not wait for another job's deploy (Forgejo's deploy jobs have their own concurrency groups); if `<base>` moved, or the push is rejected, the job goes back to rebase (5 times at most). After the push the queue fetches `<base>` again and records the push only if the pushed commit is on `origin/<base>`; otherwise the job is blocked.
4. **deploy**: Forgejo's runs for the pushed commit. A run cancelled by a quicker next push (`cancel-in-progress`) follows the run of the newer commit on `<base>` that contains it: running waits, success merges, failure blocks. If its run failed, was cancelled, or is missing, the queue also checks for a successful deploy of a later commit. Git must confirm that the later commit contains the pushed commit and is on the fetched base branch; its observed workflows must all have succeeded or been skipped, with at least one success. That marks the job merged, recording the superseding commit and runs in the job's `last_error` field as a completion note. No run within 3 minutes means no CI: merged.

A failing check, conflicts the resolver left, or a refused push go back to the agent as a message in its session; it fixes, commits and runs `tjob done` again. A failed deploy without a successful descendant **blocks** the job (`tjob retry <id>` after rerunning it in Forgejo). Every step is recorded before it runs, so a restart of the CLI server resumes each job at its step; the check and the push are also effect-outbox rows (below). When each step began is kept too (`merge_step_history`; `check:run` is when the check got its slot): `tjob show` and the API's `mergeSteps` give each step's duration. A job that was mid-turn when the server restarted is told to continue.

## Restart-safe action record (effect outbox)

Every side effect of the orchestrator is written to the `orchestrator_effects` table **before** it runs: one row per effect with an idempotency key, a replay flag, a state (`pending` → `running` → `done` / `failed`, or `dropped`), its attempt count and the boot id of the server process that ran it. The state machines (jobs, CI/CD queue, hub wake, usage recovery) are unchanged; the outbox wraps their effect calls. Why: on 2026-11-06/07 restarts ran a job twice (resume + re-attach), recorded a merge state whose push never reached main, and left cleanups half-done.

| Effect | Key | Replay | After a restart |
|---|---|---|---|
| `start_turn` (every turn sent to a job) | `turn:<job>:<uuid>` | process-bound | kept (adopted) when its detached turn re-attached, else dropped; open until the turn ends |
| `recovery_resume` (restart continue) | `resume:restart:<job>:<the cut turn's key>` | safe | sent once; not sent again if its turn had already started |
| `recovery_resume` (usage-limit continue) | `resume:limit:<job>:<recovery key>:<attempt>:<due>` | safe | sent once, the recovery marked delivered |
| `abort_turn` (`tjob cancel`) | `abort:<job>:<session>:<time>` | safe, undo | aborted again |
| `merge_check` | `check:<job>:<HEAD>:<when the job entered check>` | process-bound | dropped; the queue runs the check again. A check that passed is not run again: the job goes to `push` |
| `push` | `push:<job>:<HEAD>:<when the job entered push>` | safe | the push step runs again: it records a push already on origin, else pushes. A job past `push` whose `pushed_sha` is not on origin goes back to `push` |
| `cleanup` (finished worktree) | `cleanup:<job>:<cancelled\|merged>:<updated_at>` (automatic sweep) | safe, undo | cleaned again; a later sweep finds it done |
| `hub_wake` | `hub-wake:<hub session>:<generation>:<offset>` | process-bound | dropped: its events were not committed and go out again; a wake already done only commits its offset |

On startup, after detached turns re-attach and before anything new runs, the outbox replays the safe rows the old process left `pending` or `running` (undos first), adopts or drops the process-bound ones with the reason in `last_error`, and retries failed undos (5 attempts in all). While a job's undo still fails, its replayed start turns, resumes, checks and pushes are held (`pending`, `last_error` "held: …"), exactly as live ones are blocked, and run once the undo is done. Then the jobs' own recovery sends at most one continue per cut turn. Asking again for an effect whose key is `done` (a second restart, the hub, the next tick) does nothing.

**A failing undo blocks its job.** While an `abort_turn` or `cleanup` of a job is `failed`, that job's new turns, resumes, checks and pushes are refused (`last_error` says why; the queue blocks the job). `tjob resume` retries the undo first and answers 409 while it still fails. Other jobs are not affected.

**Usage recovery:** armed recoveries stay on the job (`limit_recovery`); only their delivery is an outbox row, so a restart between arming and sending delivers it once, and the restart continue is not sent on top of it.

Done and dropped rows are pruned 14 days after their last write. Reimplemented after T3 Code's EffectOutbox and ProviderRuntimeRecoveryService (MIT).

## From a session: wait, or send to the load balancer

While a session is busy, a message can still wait for it (the queue), or go to the load balancer instead: the shuffle button in the composer (the message being written) and **To load balancer** on each queued message. The message becomes a job in the repository the session works in (its main checkout, also when the session is itself a job), on whichever backend is least busy, and the composer says which. Messages with attached files stay with their session.

## `tjob`

```
tjob new "<title>" [--repo PATH] [--backend auto|claude|codex|glm|agy|zcode] [--model ID] [--base BRANCH] [--prompt TEXT]   # else the prompt from stdin
tjob ls | show <id> | done <id> | cancel <id> | retry <id> | resume <id>
tjob rollback <id> <turn> [--discard-untracked]
```

`--model` takes a model the backend offers, as its full id or the part after the `/` (`--model glm-5.3` for the full GLM). Any other is refused, naming the ones offered. With `--backend auto`, the model picks the backend. `tjob ls` shows each job's model.

It talks to the local server with the token in `~/.cloudcli/orchestrator.token` (0600), sent on curl's stdin.

### Per-turn checkpoints and rollback

When a job's turn ends, the orchestrator snapshots its whole worktree (committed or not, untracked files included; ignored files excluded) onto `refs/tribeira/checkpoints/<job>/<turn>`, one checkpoint per ended turn. The snapshot is a `git write-tree` through a temporary index, so HEAD, the real index and the stash are never touched (the approach follows T3 Code's CheckpointStore, MIT). `tjob rollback <id> <turn>` restores the worktree files to how that turn left them: tracked files come back at their checkpoint content, tracked files created after the checkpoint are removed (git still has them), checkpoint-untracked files come back untracked, ignored files stay put, and HEAD never moves — commits made after the checkpoint survive and show up as unstaged differences. Untracked work is never deleted: when untracked files would be lost (absent from the checkpoint, or changed since), the rollback is refused and lists them; `--discard-untracked` moves them into `.tribeira-rollback/<timestamp>/` inside the worktree instead (that folder is listed in the repository's `info/exclude`). Rollback refuses while the job is running or being prepared, the repository main checkout (shared with every other session), and any worktree that is not the job's own: it must be registered at the job's `worktree_path` with the job's branch checked out. A worktree removed by cleanup is recreated from the job's branch first. Captures of one job are serialized and each ref is created with compare-and-swap, so overlapping turn ends never share a turn number; capture and rollback are recorded in the effect outbox (`checkpoint`, `rollback`; process-bound, never blocking), and a failed capture never fails or blocks the job's turn. When a job merges or is cleaned up, its checkpoint refs are pruned so git can garbage-collect the snapshots.

## Hub events log

When a job changes state (`review`, `review_fyi`, `blocked`, `merge_failed`, `turn_ended`, `merged`, `stalled`, `waiting`), the orchestrator appends one tab-separated line to `~/.cache/cli/hub-events.log` (mode `0600`):

```text
<iso-timestamp>\t<job-id>\t<state>\t<title>\t<reason>
```

A hub or watching process can follow this file with `tail -F ~/.cache/cli/hub-events.log` without polling the server or injecting messages into sessions.

Under test (`node --test`/`tsx --test`, which set `NODE_TEST_CONTEXT`, or `NODE_ENV=test`) the live log is never used: without `CLI_HUB_EVENTS_LOG`, or with it pointing at the live log, events go to `$TMPDIR/cli-test-hub-events-<pid>.log`. The hub wake also refuses to deliver under test unless a `runTurn` sink is injected or both `DATABASE_PATH` and the events log are the test's own, so a test run (including the merge queue's `npm test`) can never wake the real hub.


### Finished job cleanup

After a job merges or is cancelled and its session stops, the orchestrator removes its clean worktree while keeping its branch. Dirty or inaccessible worktrees are kept and logged. Configure optional per-job build directories in `~/.config/cli/orchestrator.json`, for example `"cleanup": { "buildDirs": { "tsge": "~/.cache/tsge-targets/{id}" } }`. Templates must be absolute (or start with `~/`) and end in `{id}`. Run `tjob cleanup --dry-run` to inspect finished jobs, or `tjob cleanup` to sweep them. Resuming a cancelled job whose worktree was removed recreates it from its retained branch.
