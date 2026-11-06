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

### Configuration

Caps, models and the rest can be overridden in `~/.config/cli/orchestrator.json` (see `orchestrator-config.service.ts`), with no rebuild. For example, switching GLM jobs to ZCode, and setting GLM even in its peak hours:

```json
{
  "glmProvider": "zcode",
  "glmPeakHours": { "avoid": false }
}
```

A backend's `models` maps the models a job may ask for to the label of its session (`GLM Flash`); setting it replaces the whole list. The default `model` is always allowed.

## CI/CD queue

Optional local symbol/dependency maps for Claude, Codex, GLM and agy jobs are documented in [Graphify project maps](graphify.md). They are disabled by default and use one bounded shell interface without changing model selection or job completion rules.

`tjob done` puts the branch in the queue. Per repository, one job at a time goes through:

1. **rebase** onto the latest `origin/<base>`. Conflicts are resolved by Gemini 3.8 Flash (`agy`); what it cannot settle goes back to the job's agent.
2. **check**: a light gate, never the full suite (the user, 2026-11-03: Forgejo CI is the only full gate; a red main is fixed afterwards). In order: the configured command (`checks` in the config), the repository's `scripts/merge-gate.sh`, then per stack `npm run typecheck && npm run lint` (whichever exist, never `test`/`check`), `mvn -q -o test-compile` (online if offline fails), `cargo check --all-targets --quiet`, `python -m pytest --collect-only -q` (through `scripts/hermes-env.sh` when present, plus `ruff check` when ruff is configured), and `scripts/check.sh` only when nothing lighter applies. At most `maxConcurrentChecks` (default 1) checks run at once on the workstation, under `nice -n 10`; the others wait in `check`.
3. **push** to `<base>`. It does not wait for another job's deploy (Forgejo's deploy jobs have their own concurrency groups); if `<base>` moved, or the push is rejected, the job goes back to rebase (5 times at most).
4. **deploy**: Forgejo's runs for the pushed commit. A run cancelled by a quicker next push (`cancel-in-progress`) follows the run of the newer commit on `<base>` that contains it: running waits, success merges, failure blocks. If its run failed, was cancelled, or is missing, the queue also checks for a successful deploy of a later commit. Git must confirm that the later commit contains the pushed commit and is on the fetched base branch; its observed workflows must all have succeeded or been skipped, with at least one success. That marks the job merged, recording the superseding commit and runs in the job's `last_error` field as a completion note. No run within 3 minutes means no CI: merged.

A failing check, conflicts the resolver left, or a refused push go back to the agent as a message in its session; it fixes, commits and runs `tjob done` again. A failed deploy without a successful descendant **blocks** the job (`tjob retry <id>` after rerunning it in Forgejo). Every step is recorded before it runs, so a restart of the CLI server resumes each job at its step. When each step began is kept too (`merge_step_history`; `check:run` is when the check got its slot): `tjob show` and the API's `mergeSteps` give each step's duration. A job that was mid-turn when the server restarted is told to continue.

## From a session: wait, or send to the load balancer

While a session is busy, a message can still wait for it (the queue), or go to the load balancer instead: the shuffle button in the composer (the message being written) and **To load balancer** on each queued message. The message becomes a job in the repository the session works in (its main checkout, also when the session is itself a job), on whichever backend is least busy, and the composer says which. Messages with attached files stay with their session.

## `tjob`

```
tjob new "<title>" [--repo PATH] [--backend auto|claude|codex|glm|agy|zcode] [--model ID] [--base BRANCH] [--prompt TEXT]   # else the prompt from stdin
tjob ls | show <id> | done <id> | cancel <id> | retry <id> | resume <id>
```

`--model` takes a model the backend offers, as its full id or the part after the `/` (`--model glm-5.3` for the full GLM). Any other is refused, naming the ones offered. With `--backend auto`, the model picks the backend. `tjob ls` shows each job's model.

It talks to the local server with the token in `~/.cloudcli/orchestrator.token` (0600), sent on curl's stdin.

## Hub events log

When a job changes state (`review`, `blocked`, `merge_failed`, `turn_ended`, `merged`), the orchestrator appends one tab-separated line to `~/.cache/cli/hub-events.log` (mode `0600`):

```text
<iso-timestamp>\t<job-id>\t<state>\t<title>\t<reason>
```

A hub or watching process can follow this file with `tail -F ~/.cache/cli/hub-events.log` without polling the server or injecting messages into sessions.

Under test (`node --test`/`tsx --test`, which set `NODE_TEST_CONTEXT`, or `NODE_ENV=test`) the live log is never used: without `CLI_HUB_EVENTS_LOG`, or with it pointing at the live log, events go to `$TMPDIR/cli-test-hub-events-<pid>.log`. The hub wake also refuses to deliver under test unless a `runTurn` sink is injected or both `DATABASE_PATH` and the events log are the test's own, so a test run (including the merge queue's `npm test`) can never wake the real hub.

