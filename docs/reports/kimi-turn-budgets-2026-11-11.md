# Kimi turn budgets: offline baseline, 2026-11-11

Decision: the person, 2026-11-11 19:30 UTC (backlog.md): enforce ~800 billed output tokens and ~5,000 uncached input tokens per Kimi call, expose calls over either budget in `tjob status`, and re-measure capped-call rate (<2%), pacer wait and tokens/merged over a later 24 h window.

## Enforcement

- `morph-pacer` `turnBudgets.kimik31 = { out: 800, uncachedIn: 5000 }` (defaults). Output is capped with `max_tokens`; a request whose estimated uncached input is over budget is refused with HTTP 413 before it reaches Morph. Prompts are never truncated.
- The ledger records the decision in an optional `budget` object, including `input_rejected` and `over_out`/`over_in` from actual usage.
- `tjob status` / `STATUS.md` add a `kimi budget` line per 1 h and 24 h efficiency window, with over-calls split by hub/planner/job/compaction role from OpenCode sessions and refused input calls from the ledger. An unavailable session source prints `usage unavailable`, not zero.
- The existing 30-minute Kimi-task split rule stays the orchestrator health check (`health.maxRunMin`, default 30).

## Offline baseline (read-only ledger, 24 h to 2026-11-11 20:09 UTC)

Source: `~/.local/state/morph-pacer/ledger.jsonl`, Kimi model ids only. This is the pre-enforcement window.

| Measure | Value |
|---|---:|
| Kimi calls | 3,669 |
| Over output budget (>800 billed out) | 342 (9.3%) |
| Over input budget (>5,000 uncached in) | 589 (16.1%) |
| Over either budget | 804 (21.9%) |
| 429 responses | 401 (10.9%) |
| Retries | 4,913 |
| Pacer wait | 2,753,250 ms (~45.9 min) |
| Output tokens | 1,601,932 |
| Uncached input tokens | 13,967,399 |

Completion of the target measurement (capped-call rate <2%, pacer wait, tokens/merged) is deferred to the later 24 h window after this change is deployed, as the job brief requires. The status CLI is the pointer: `tjob status` prints the same per-window budget counts and waste figures live.

## Verification

Focused only:

- `morph-pacer/tests/turn-budgets.test.ts` (6): defaults, input AT/ABOVE, output AT/ABOVE, DeepSeek not capped, actual-usage over flags.
- `morph-pacer/tests/*.test.ts` (39 total).
- `server/modules/orchestrator/tests/status.test.ts` (6) and `tjob.cli.test.ts` (17).
- `tsc --noEmit` for `server` and `morph-pacer`; oxlint on the touched files.

No live model calls, production DB changes, global config mutation or service restart.
