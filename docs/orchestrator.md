# Orchestrator: coding jobs over Claude, GPT and GLM

The orchestrating session (any chat in CLI) hands coding tasks to `tjob new`. Each task becomes a **job**: a real CLI session, named `Claude · …`, `GPT · …`, `GLM Flash · …` or `GLM · …` (the full GLM model) in the Sessions tab, running in its own git worktree (`~/Tribeira/.jobs/<repo>/<id>`, branch `job/<slug>-<id>`). Open it and talk to it like any other session.

## Balancing

| Backend | Runtime | Model (default · on request) | Cap |
|---|---|---|---|
| `claude` | Claude Agent SDK | `claude-opus-5-5` (high) | 2 |
| `codex` (GPT) | Codex | `gpt-6.1-sol` (medium) | 2 |
| `glm` | OpenCode, Z.ai Coding Plan | `zai-coding-plan/glm-5.3-flash` · `zai-coding-plan/glm-5.3` | 3 |

- A job without a backend goes to whichever backend is working on the fewest jobs (under its cap); ties go to the cheapest (GLM, then GPT, then Claude).
- A job that asks for a backend gets it while it is under its cap, and GLM when it is not.
- During GLM's peak hours (below), a job without a backend goes to GLM only when Claude and GPT have no room (`glmPeakHours.avoid`, on by default).
- With no room, the job waits (`queued`) and starts when a slot frees, oldest first.
- A job holds its slot while it is being set up and while its agent works **or waits for an answer**. It frees it when it is **finished**: its agent ran `tjob done <id>` (code complete and committed), or the person told the session they do not want the job anymore (its agent runs `tjob cancel <id>`; `tjob resume` brings it back). Pressing Stop is **not** finishing: it is a change of direction or more context coming, and the job keeps its slot.

The Codex runtime runs `$CODEX_PATH` when set, else the first `codex` on the server's PATH (outside `node_modules/.bin`), else the binary bundled with `@openai/codex-sdk`; it logs which one and its version on the first Codex turn. The bundled copy lags and can refuse newer models such as `gpt-6.1-sol`.

### GLM: Flash by default, the full model on request

The Coding Plan's week is 60,000 credits. Per 10,000 tokens, GLM-5.3 costs 6.9 (input), 1.7 (cached) and 24 (output); GLM-5.3-Flash 2.3, 0.56 and 8, about a third. A long OpenCode session re-reads its whole context every step (one job: 267 steps, 37M cached tokens, ~3,700 credits), and most jobs do not need the full model, so GLM jobs run Flash unless `tjob new --model glm-5.3` asks for the full one. A job keeps its model on every later turn: CI/CD queue messages, `tjob resume`, and the "continue" after a restart. A job that asked for another backend's model and was sent to GLM (its backend at its cap) runs GLM's default.

**Peak hours:** Z.ai reportedly charges more on weekdays 14:00-18:00 UTC+8 (03:00-07:00 in São Paulo, `glmPeakHours` in the config). In that window, jobs without a backend go to Claude or GPT while they have room.

### Configuration

Caps, models and the rest can be overridden in `~/.config/cli/orchestrator.json` (see `orchestrator-config.service.ts`), with no rebuild. For example, the full GLM model by default, and GLM even in its peak hours:

```json
{
  "backends": { "glm": { "model": "zai-coding-plan/glm-5.3" } },
  "glmPeakHours": { "avoid": false }
}
```

A backend's `models` maps the models a job may ask for to the label of its session (`GLM Flash`); setting it replaces the whole list. The default `model` is always allowed.

## CI/CD queue

Optional local symbol/dependency maps for Claude, Codex and GLM jobs are documented in [Graphify project maps](graphify.md). They are disabled by default and use one bounded shell interface without changing model selection or job completion rules.

`tjob done` puts the branch in the queue. Per repository, one job at a time goes through:

1. **rebase** onto the latest `origin/<base>`. Conflicts are resolved by Gemini 3.8 Flash (`agy`); what it cannot settle goes back to the job's agent.
2. **check**: the repository's checks (config, `scripts/check.sh`, `npm run check`, `npm test`, Maven, Cargo, pytest).
3. **push** to `<base>`. It waits while the previous push of the same repository is still deploying; if `<base>` moved, or the push is rejected, the job goes back to rebase (5 times at most).
4. **deploy**: Forgejo's runs for the pushed commit. If its run failed, was cancelled, or is missing, the queue also checks for a successful deploy of a later commit. Git must confirm that the later commit contains the pushed commit and is on the fetched base branch; its observed workflows must all have succeeded or been skipped, with at least one success. That marks the job merged, recording the superseding commit and runs in the job's `last_error` field as a completion note. No run within 3 minutes means no CI: merged.

A failing check, conflicts the resolver left, or a refused push go back to the agent as a message in its session; it fixes, commits and runs `tjob done` again. A failed deploy without a successful descendant **blocks** the job (`tjob retry <id>` after rerunning it in Forgejo). Every step is recorded before it runs, so a restart of the CLI server, or another job's deploy, resumes each job at its step. A job that was mid-turn when the server restarted is told to continue.

## From a session: wait, or send to the load balancer

While a session is busy, a message can still wait for it (the queue), or go to the load balancer instead: the shuffle button in the composer (the message being written) and **To load balancer** on each queued message. The message becomes a job in the repository the session works in (its main checkout, also when the session is itself a job), on whichever backend is least busy, and the composer says which. Messages with attached files stay with their session.

## `tjob`

```
tjob new "<title>" [--repo PATH] [--backend auto|claude|codex|glm] [--model ID] [--base BRANCH] [--prompt TEXT]   # else the prompt from stdin
tjob ls | show <id> | done <id> | cancel <id> | retry <id> | resume <id>
```

`--model` takes a model the backend offers, as its full id or the part after the `/` (`--model glm-5.3` for the full GLM). Any other is refused, naming the ones offered. With `--backend auto`, the model picks the backend. `tjob ls` shows each job's model.

It talks to the local server with the token in `~/.cloudcli/orchestrator.token` (0600), sent on curl's stdin.
