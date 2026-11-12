# Morph rate-limit probe — protocol and offline validation

Job `ce06a60f`. Adds a bounded direct probe beside the deployed pacer. It does not change the pacer's
live defaults, route traffic through the probe, or mutate the live ledger/config. No live model call
was made in this job.

## Files

- `morph-pacer/src/probe.ts` — probe loop, local sliding-60s window, combined live+probe accounting,
  escalation, guards and classification.
- `morph-pacer/src/probe-cli.ts` — CLI and real HTTPS transport. The key is read from
  `~/.config/morph/api_key` in-process only; never printed, put in argv, or written to a report.
- `morph-pacer/tests/probe.test.ts` — offline tests with a fake transport and `FakeClock`.

## Protocol

- Direct `POST https://api.morphllm.com/v1/chat/completions`; one model per invocation, one request in
  flight, synthetic prompts, no automatic retries.
- Before every call: `GET http://127.0.0.1:8198/pacer/usage` with a bounded timeout, then
  `combined = live window + probe's own sliding-60s window`. Direct probe traffic bypasses the live
  ledger, so the probe keeps its own window and adds it to the live one.
- Record exact returned prompt/completion tokens, status, latency, `Retry-After`, model, step, and the
  live/probe/combined uncached input and output occupancy.
- Abort immediately on missing or unreadable usage. Never infer a ceiling from token estimates.
- Three successful calls at one level before escalation. The next target is twice the
  provider-observed prompt/completion tokens, not an estimate.
- Stop at deadline, per-model input/output budget, cumulative call cap, input/output step caps, second
  consecutive 429, missing usage, or live-load/admission guard failure.
- A below-cap 429 is `cap-not-explanatory`, never a proven ceiling. A ceiling claim requires a
  repeatable 429 threshold plus below-threshold successes; guards make the result `inconclusive`.
- `Retry-After` is honored within the deadline. A wait that would cross the deadline stops the run.
- Output is sanitized JSON: judgments, windows, statuses and token counts only. No key, request
  payload, or provider body.

## Bounds

| Bound | Value |
|---|---|
| Total deadline | 20 min |
| Cumulative calls (including failures) | 160 |
| Input-escalation steps | 60 |
| Output-escalation steps | 30 |
| Successes per level | 3 |
| Per-model input/output budget | finite, from the model's pacer cap |

## CLI

```sh
# Offline plan, no network (default)
npx tsx morph-pacer/src/probe-cli.ts

# Offline self-check with a fake transport and fake clock, no network
npx tsx morph-pacer/src/probe-cli.ts --test

# Real transport requires the explicit acknowledgement
npx tsx morph-pacer/src/probe-cli.ts --live --model morph-dsv41flash
```

DeepSeek is the default and must run before Kimi. The CLI accepts one model per invocation.

## Offline validation

```sh
npx tsx --test morph-pacer/tests/probe.test.ts
```

Result: 12/12 pass. Covered: three-success escalation using observed token units; second consecutive
429 halt; missing-usage abort; `Retry-After` deadline guard; live-load guard before dispatch; deadline
guard; two low-token passes then a below-cap 429 preserving input+output occupancy and not claiming a
ceiling; combined live+probe window recomputed between sequential calls; call cap and input step cap;
redaction of prompts, bodies and credentials; CLI offline default/dry-run/`--test` paths and explicit
`--live` acknowledgement.

Focused checks:

```sh
npx tsc --noEmit -p morph-pacer/tsconfig.json
npx oxlint morph-pacer/src/probe.ts morph-pacer/src/probe-cli.ts morph-pacer/tests/probe.test.ts
```

Both pass. No full workspace gate was run.
