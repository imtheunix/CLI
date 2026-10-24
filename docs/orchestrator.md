# Orchestrator: coding jobs over Claude, GPT and GLM

The orchestrating session (any chat in CLI) hands coding tasks to `tjob new`. Each task becomes a **job**: a real CLI session, named `Claude · …`, `GPT · …` or `GLM · …` in the Sessions tab, running in its own git worktree (`~/Tribeira/.jobs/<repo>/<id>`, branch `job/<slug>-<id>`). Open it and talk to it like any other session.

## Balancing

| Backend | Runtime | Model | Cap |
|---|---|---|---|
| `claude` | Claude Agent SDK | `claude-opus-5-5` (high) | 2 |
| `codex` (GPT) | Codex | `gpt-6.1-sol` (medium) | 2 |
| `glm` | OpenCode, Z.ai Coding Plan | `zai-coding-plan/glm-5.3` | 3 |

- A job without a backend goes to whichever backend is working on the fewest jobs (under its cap); ties go to the cheapest (GLM, then GPT, then Claude).
- A job that asks for a backend gets it while it is under its cap, and GLM when it is not.
- With no room, the job waits (`queued`) and starts when a slot frees, oldest first.
- A job holds its slot while it is being set up and while its agent works **or waits for an answer**. It frees it when it is **finished**: its agent ran `tjob done <id>` (code complete and committed), or the person told the session they do not want the job anymore (its agent runs `tjob cancel <id>`; `tjob resume` brings it back). Pressing Stop is **not** finishing: it is a change of direction or more context coming, and the job keeps its slot.

Caps, models and the rest can be overridden in `~/.config/cli/orchestrator.json` (see `orchestrator-config.service.ts`), with no rebuild.

## CI/CD queue

`tjob done` puts the branch in the queue. Per repository, one job at a time goes through:

1. **rebase** onto the latest `origin/<base>`. Conflicts are resolved by Gemini 3.8 Flash (`agy`); what it cannot settle goes back to the job's agent.
2. **check**: the repository's checks (config, `scripts/check.sh`, `npm run check`, `npm test`, Maven, Cargo, pytest).
3. **push** to `<base>`. It waits while the previous push of the same repository is still deploying; if `<base>` moved, or the push is rejected, the job goes back to rebase (5 times at most).
4. **deploy**: Forgejo's runs for the pushed commit. No run within 3 minutes means no CI: merged.

A failing check, conflicts the resolver left, or a refused push go back to the agent as a message in its session; it fixes, commits and runs `tjob done` again. A failed deploy **blocks** the job (`tjob retry <id>` after rerunning it in Forgejo). Every step is recorded before it runs, so a restart of the CLI server, or another job's deploy, resumes each job at its step. A job that was mid-turn when the server restarted is told to continue.

## `tjob`

```
tjob new "<title>" [--repo PATH] [--backend auto|claude|codex|glm] [--base BRANCH] [--prompt TEXT]   # else the prompt from stdin
tjob ls | show <id> | done <id> | cancel <id> | retry <id> | resume <id>
```

It talks to the local server with the token in `~/.cloudcli/orchestrator.token` (0600), sent on curl's stdin.
