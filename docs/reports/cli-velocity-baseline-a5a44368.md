# CLI velocity baseline — chat open, first delta, socket delivery

Measured 2026-11-11 on the job worktree (`feature/cli-velocity-measured-baseline-chat-open-a5a44368`).
This is a baseline only: no production code or UI changed.

## Method

`scripts/bench/cli-velocity.ts` starts an isolated in-process server on a free
port with a temp `DATABASE_PATH` and a temp `HOME`. Server modules are loaded
only after both are redirected, so no module can open the real
`~/.cloudcli/auth.db` or read real provider directories. It never contacts a
live server or a real model. A stubbed provider turn emits its first
`stream_delta` immediately, so the numbers are our spawn/dispatch/transport
cost, not model time.

Fixture: 10,000 Codex sessions across 20 projects (500 sessions per project).
The 10 most recent sessions have real JSONL transcripts (20 turns each); the
history cache is invalidated before every measured chat open so each first
message page is a cold read.

- 5 warmup iterations, 30 measured iterations per path.
- p50/p95 are linear-interpolated percentiles over the measured samples.
- Node v22.23.4, Linux 7.0.0-38-generic, 16 CPUs.

Reproduce:

```bash
npm run bench:cli-velocity
# or with explicit scale:
npm run bench:cli-velocity -- --iterations 30 --warmup 5 --sessions 10000
```

## Results (milliseconds)

| Path | n | p50 | p95 | min | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chat open: session list (`GET /api/providers/sessions/recent`) | 30 | 4.930 | 6.872 | 4.611 | 7.895 |
| Chat open: first message page, per session (`GET /api/providers/sessions/:id/messages?limit=20`) | 30 | 1.281 | 1.675 | 1.045 | 2.101 |
| Chat open: list + 10 first pages (one open) | 30 | 17.939 | 23.961 | 15.090 | 26.498 |
| Send -> first assistant delta (real chat websocket, stubbed turn) | 30 | 0.556 | 0.774 | 0.473 | 0.844 |
| Server event -> socket delivery (synthetic event through the run writer) | 30 | 0.071 | 0.100 | 0.067 | 0.102 |
| Session list at scale, per project (`GET /api/projects/:id/sessions?limit=20`) | 30 | 1.315 | 1.712 | 1.207 | 1.876 |

## Index re-verification at 10k sessions

The benchmark fails if either sidebar query stops using the composite index.
With 10,000 fixture sessions:

```
page:  SEARCH sessions USING INDEX idx_sessions_project_archived (project_path=? AND isArchived=?)
       USE TEMP B-TREE FOR ORDER BY
count: SEARCH sessions USING COVERING INDEX idx_sessions_project_archived (project_path=? AND isArchived=?)
```

## Reading the numbers

- Opening a chat is dominated by the recent-session list at 10k rows
  (~4.9 ms p50); each cold first message page is ~1.3 ms p50, so a full open
  of the 10 recent sessions is ~17.9 ms p50 / ~24.0 ms p95.
- The send path is sub-millisecond p50 (~0.56 ms) with the stub emitting
  immediately: that is the websocket dispatch, run registration, writer
  sequencing and first frame delivery, with no model or process spawn time.
- A server-side event reaches the client socket in ~0.07 ms p50, so the
  transport itself is not the bottleneck.
- The per-project sidebar list stays ~1.3 ms p50 at 10k sessions and uses the
  composite index for both the page and the count.
