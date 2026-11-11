# Continuation stall: root cause

**Cause: the health tick has no condition for "active job, no live turn, no error".**
It never re-prompts a job whose turn ended without `tjob done`, so the job stays
`active`/`waiting` (or `working` on a stale run) until a person or the hub acts.

## The code path

`server/modules/orchestrator/services/health.service.ts` runs one pass per tick
(`tick()`, line 265) and has exactly two actions for an active job:

- `checkNoCommit` (line 163) — the only nudge. It returns at line 173 when
  `!isBusy(job)`. `isBusy` (line 70) is
  `chatRunRegistry.isProcessing(session_id) || job.in_turn`.
- `checkDeadSlot` (line 215) — returns at line 218 unless `isWaitingForHub(job)`,
  which (line 79) requires `last_error` or a gave-up `limit_recovery`.

A turn that ends normally goes through `handleRunCompleted`
(`jobs.service.ts:1131`), which sets `in_turn: 0` (line 1186) and clears
`last_error` on a clean exit (line 1192). The job is then `active`, not busy,
and not waiting for the hub — so **both** health checks skip it. Nothing else
resumes it:

- `sweepLimitRecoveries` (`jobs.service.ts:457`) only runs when
  `limit_recovery` is armed (usage limit / auth), not after a normal turn end.
- `recover()` (`jobs.service.ts:1244`) only runs at server startup.
- The `turn_ended` hub event is a notification to the hub, not a resume of the
  job's own session.

So the answer to "does the health tick re-prompt?" is **no**. The only
auto-continue prompts are `LIMIT_CONTINUE_PROMPT` (limit recovery) and
`RESTART_PROMPT` (startup recovery); a plain "turn ended without tjob done" has
no continuation path.

## Evidence

`~/.cache/cli/hub-events.log` for job `016e8486` (morph DeepSeek, J7m):

```
17:12:54  merge_failed  ... tsge-merge-check ... signal: SIGTERM
17:13:42  turn_ended    ... turn ended without tjob done
17:24:30  turn_ended    ... turn ended without tjob done
```

After the last `turn_ended` the job sat `waiting` with frozen tokens. The DB
row at that point was `state=active, in_turn=0, last_error=null,
limit_recovery=null` — exactly the state both health checks ignore. The
merge-gate SIGTERM only caused the `merge_failed` message; the stall is that
the follow-up turn ended and nothing re-prompted it.

Job `37fc624e` (GLM-5.3-Flash via zcode) is the same gap on the other side of
`isBusy`: its zcode run never settled, so `chatRunRegistry.isProcessing()`
stayed `true` after the process was gone. `isBusy` therefore stayed `true`,
`checkNoCommit` skipped the nudge (it only nudges a *busy* job), `recover()`
skipped it (`isProcessing`), and the view showed `working` with tokens frozen
at 168931/6495 and no live process. Health trusts the in-memory run flag and
never checks that the run is actually alive or making progress.

## One-line summary

Health's only re-prompt is gated on `isBusy`, and its only escalation is gated
on `last_error`; a job that is active but neither busy nor errored (or whose
run flag is stale) has no path back to a turn, so it waits forever.
