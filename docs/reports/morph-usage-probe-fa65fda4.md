# Bounded Morph usage probe (fa65fda4)

## What was built

- `morph-pacer/src/probe.ts`: guarded direct-provider ceiling probe with an injected transport, an injected clock and
  an injected live-usage fetcher. `MORPH_CHAT_COMPLETIONS_URL` is the only provider endpoint constant.
- `morph-pacer/src/probe-cli.ts` and `npm run probe:morph`: dry-run by default. Live transport needs both `--live` and
  `MORPH_PROBE_ALLOW_LIVE=1`.
- `morph-pacer/tests/probe.test.ts`: focused offline tests with a fake transport and `FakeClock`.

## Protocol

1. Dry run: return the plan with `conclusion.kind = dry_run`, `tested = false`, zero calls, no key lookup.
2. Live: read the key inside the process from `~/.config/morph/api_key`; never print it.
3. Before every request, read the local `/pacer/usage` shape with a bounded timeout. Combine the live window and the
   probe's own sliding-60s window, then admit only if live + probe + planned input/output fits the assumed caps
   (default 240,000 uncached input / 32,000 output); otherwise wait and re-read, bounded by the hard deadline.
4. Send one synthetic request at a time. DeepSeek is the default model; no concurrent models and no retries.
5. Record actual `prompt_tokens` / `completion_tokens`, status, latency, `Retry-After`, model, planned level and the
   probe/live/combined occupancy. Add only real provider usage to the probe window.
6. Stop on: two consecutive 429s, any capacity error, a 2xx without usage, unavailable live admission, or the hard
   deadline. Respect `Retry-After`; a wait past the deadline stops before another request.
7. Three successes are required per level. A single 429 followed by a success is retained as a below-limit 429, not a
   ceiling claim. Output separates `observed` window values from `assumedCaps` and marks untested conclusions.

## Verification

- `npx tsx --test morph-pacer/tests/probe.test.ts`: 12 passed.
- `npx tsc --noEmit -p morph-pacer/tsconfig.json`: clean.
- `npx oxlint morph-pacer/src/probe.ts morph-pacer/src/probe-cli.ts morph-pacer/tests/probe.test.ts`: clean.

No live provider call, no real key lookup, no pacer config/ledger change and no installation happened in this job.
A live DeepSeek (then Kimi) measurement is a separate hub-gated run.
