# Morph ceiling probe (job 76f763df)

Built a bounded, key-safe direct Morph rate-limit probe beside the pacer:

- `morph-pacer/src/probe.ts` — protocol, per-group sliding-60s probe window, combined live+probe admission math, stop conditions, ceiling classification.
- `morph-pacer/src/probe-transport.ts` — live `POST /v1/chat/completions` and `GET /pacer/usage` transport; reads the key in process only.
- `morph-pacer/src/probe-cli.ts` — offline-by-default CLI; `--live` is the explicit acknowledgement, `--test` is an offline self-test.
- `morph-pacer/tests/probe.test.ts` — 16 focused offline tests with a fake transport and fake clock.

## Protocol

- One model at a time, DeepSeek before Kimi, one request in flight, no automatic retries, synthetic prompts.
- Before dispatch: fetch pacer usage with a bounded timeout, add the live 60-second window to the probe's own per-group window, and require the planned combined load to fit under the 240,000 input / 32,000 output per-request cap.
- Stop on the 20-minute deadline, a level above the request cap, a second consecutive 429, missing/unreadable usage, or a live-load/admission guard failure.
- Three successes at a level before escalation.
- A 429 below the live cap is `cap-not-explanatory` and is not a proven ceiling. A ceiling is reported only for a cap-explanatory 429 after three successes at the previous level.
- The report records returned prompt/completion tokens, status, latency, `Retry-After`, model, step, and live/probe uncached input/output occupancy. No provider payload or secret.

## Verification (offline only; no model calls)

- `npx tsx --test morph-pacer/tests/probe.test.ts` — 16/16 pass.
- `npm run test:morph-pacer` — 49/49 pass.
- `npx tsc --noEmit -p morph-pacer/tsconfig.json` — clean.
- `npx oxlint morph-pacer/src/probe.ts morph-pacer/src/probe-transport.ts morph-pacer/src/probe-cli.ts morph-pacer/tests/probe.test.ts` — clean.

No live measurement was started; the hub separates that after protocol review.
