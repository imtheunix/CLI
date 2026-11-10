# Bounded refutation lifecycle — 2026-11-10

Job `2919474b` fixes the refutation lifecycle in the automatic-review candidate.

- A pending refutation now times out after a configurable duration, defaulting to 20 minutes and capped at 20 minutes. Timeout aborts and archives the reviewer session, releases `inFlight`, parks the job for the hub with `refutation timed out`, and permits neither approval nor retry.
- Cancelling a job aborts its detached refutation and archives that session; a late result is discarded. An orchestrator restart resolves the persisted session from its terminal provider transcript before starting a second CLI run.
- A raw `false` from a message-free reopen now restores the prior `done/review` state and requests a hub fix or escalation instead of silencing the workflow.
- Focused adversarial regressions cover a never-settling refutation, cancellation during an active provider run, restart after terminal persistence, busy and authentication reopen failures, and timeout configuration bounds.

## Verification

- `npx --no-install tsx --test <review, refute, gate, hub, jobs, outbox, adversarial suites>`: **156 passed, 0 failed**.
- Direct detached-turn dependencies `chat-abort.test.ts` and `chat-live-transport.test.ts`: **11 passed, 0 failed**; combined final run **167 passed, 0 failed**.
- `npx --no-install tsc --noEmit -p server/tsconfig.json`: passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed with the repository's existing warnings and no errors.
