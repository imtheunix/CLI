# Morph probe: measure real I/O instead of planned levels (23d95e6b)

Offline-only change. No provider call, no live run, no Kimi measurement. The
next live protocol is prepared but not executed.

## What the first live run showed (4dda95a6)

The merged report `morph-live-probe-deepseek-4dda95a6.md` recorded nine HTTP
200s but only 53,371 / 106,704 / 213,371 actual prompt tokens for planned
60k / 120k / 240k levels, large prompt-cache hits on repeated bodies, and 13
actual completion tokens at every level despite `max_tokens` of 8k / 16k / 32k.
It established no ceiling: the old probe counted a planned level as a success
whenever a 2xx response carried usage, even when the provider returned far less
input or output than planned.

## What changed

`morph-pacer/src/probe.ts` and `probe-cli.ts` now measure actual provider usage:

- **Separate sweeps.** Output first: 128 -> 512 -> 2048 actual completion tokens
  with at most 2,000 actual uncached input. Then input: 50,000 -> 100,000 ->
  200,000 actual uncached input with a fixed 128 actual completion.
- **Actual-token thresholds.** A level succeeds only when the returned
  `completion_tokens` reaches its output target and, for input levels, the
  returned uncached input (`prompt_tokens - cached_tokens`) reaches its input
  target. Output levels additionally require uncached input to stay at or below
  their 2,000-token cap. Planned characters, `max_tokens` and the planned level
  are never counted as success.
- **Inconclusive, not capacity.** A cached or short-finished response is
  `below_threshold`; it is retried and never reported as provider capacity.
- **Wholly unique bodies.** Each request uses deterministic filler with a fresh
  seed, so the whole payload differs rather than repeating a body with a nonce
  prefix. Prompt cache cannot mask the uncached input being measured.
- **Calibration from real usage.** The character-to-token ratio is updated from
  each response's actual `prompt_tokens`; the initial 4 chars/token guess is
  replaced by measurement.
- **Deterministic long-form output.** Output levels ask for a counting sequence
  rather than `OK`, so real completion volume is requested.
- **Finite budgets and guards.** Explicit deadline, call cap, actual-token cap,
  attempts-per-level cap, combined live + probe sliding-60s admission, one
  request in flight, no transport retry, fail-closed missing usage, Retry-After,
  and two-consecutive-429 stop are retained. The CLI exposes `--mode`,
  `--levels sweep:input:output`, `--max-total-ms`, `--max-calls`, `--max-tokens`,
  `--successes-per-level`, `--max-attempts-per-level`, `--caps-in` and
  `--caps-out`.
- **Honest conclusion.** `completed` requires every level to meet its actual
  threshold. Otherwise the result is `inconclusive` or a specific safe stop, and
  it reports both actual observed maxima and actual successful maxima.

The unrelated `84b32ed0` ceiling-probe family, pacer config/runtime and other
CLI subsystems were not modified.

## Offline verification

`npx tsx --test morph-pacer/tests/probe.test.ts` passes 23 focused tests,
including: dry-run zero transport/usage/key access, unique bodies and
calibration, below-threshold rejection, observed maxima, combined caps and
admission, one-request serialization, transport/capacity/missing-usage errors,
Retry-After, consecutive-429 reset and stop, deadline/call/token/attempt caps,
and no secret in the result. `tsc --noEmit -p morph-pacer/tsconfig.json` and
`oxlint` on the changed files are clean.

## Next live protocol (prepared, not run)

When the hub explicitly gates a live run, the default levels are the six above.
The run must still use `--live` plus `MORPH_PROBE_ALLOW_LIVE=1`, the in-process
key, the combined live + probe caps and a finite deadline. Kimi is a separate
later measurement.
