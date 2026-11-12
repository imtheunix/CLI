# Independent refute of morph-probe measured-io (f81be927 / report 23d95e6b) — job 5323ef5d

Verdict: **HOLD**. One invariant from the review contract is violated and reproduced
offline; the live invocation is withheld until it is fixed. Every other checked
invariant holds with the evidence below. Offline only: no provider call, no key
access, no config/pacer/service modification, no production file touched.

Scope reviewed: `morph-pacer/src/probe.ts`, `morph-pacer/src/probe-cli.ts`,
`morph-pacer/tests/probe.test.ts`, `docs/reports/morph-probe-measured-io-23d95e6b.md`,
plus `windows.ts` / `clock.ts` / `pacer.ts` / `usage.ts` as dependencies only.
Note: `23d95e6b` is the report slug; the only code commit is `f81be927`.

## Invariants checked against the code (not the report's claims)

| Invariant | Result | Evidence |
| --- | --- | --- |
| One request in flight | holds | `probe.ts:519-734` is a single sequential loop; only one `await transport(...)` (579); no `Promise.all`. Test `probe.test.ts:293-317` asserts max in-flight 1. |
| Transport never retried | holds | thrown transport error → immediate `conclude('transport_error')` `probe.ts:589-618`; 5xx → immediate `conclude('capacity_error')` `probe.ts:727-733`; 2xx-without-usage → immediate `conclude('missing_usage')` `probe.ts:649-657`. Only 429 and below-threshold repeat, both attempt/deadline-bounded. |
| Below-threshold is inconclusive, never capacity | holds | `meetsThreshold` gates on measured values `probe.ts:386-390`; miss → `below_threshold` + retry `probe.ts:674-684`. Tests `probe.test.ts:197-245`. |
| attempts/calls/tokens/deadline finite and bounded | holds | checks at `probe.ts:524-543`, post-success `probe.ts:676, 692`; CLI `positive()` rejects non-finite/≤0 `probe-cli.ts:19-26`. Wall-clock worst case = `maxTotalMs` + one admitted call's `requestTimeoutMs` (120 s, not CLI-exposed) + ≤2 s usage-fetch per poll — any future live run must keep `--max-total-ms ≤ 1_080_000` to honor 20 min. |
| Success gated on actual prompt−cached and actual completion | holds | `uncachedIn = prompt_tokens − cached_tokens` `probe.ts:642`, `out = completion_tokens` `probe.ts:643`; `max_tokens`/planned chars never counted. Tests `probe.test.ts:132-158, 197-266`. |
| Independent sweeps + companion constraints | holds | output sweep requires `uncachedIn ≤ level.input` **and** `out ≥ level.output`; input sweep requires `uncachedIn ≥ level.input` **and** `out ≥ level.output` (`probe.ts:386-390`). |
| Wholly unique bodies + genuine calibration | holds | per-call seed advance `probe.ts:573`, seeded hash filler `probe.ts:323-335`; ratio learned from measured `prompt_tokens`, clamped to (0.5, 20) `probe.ts:660-663`. Test `probe.test.ts:160-195` asserts bodies differ beyond a nonce prefix and shrink after calibration. |
| Worst-case admission = combined live+probe sliding-60 s | holds | probe `RollingWindow(60_000)` `probe.ts:400`; live fetched per poll `probe.ts:489-500`; combined compared to caps `probe.ts:501-511`; below-threshold calls also count into the window `probe.ts:670`. |
| Missing/NaN load fail-closed | **violated (D1)** | NaN → comparisons false → never admitted → `deadline` (reproduced, 0 calls). Missing group → `live_group_unavailable` → `load_guard` stop `probe.ts:495-496`. **Missing window fields → `?? 0` → admitted as zero live load** `probe.ts:497-500`. |
| Two-consecutive-429 + Retry-After | holds | counter/reset `probe.ts:671-672, 703-712`; Retry-After parsed (seconds or HTTP-date, clamped ≥0) `probe.ts:265-276`; wait pre-checked against deadline `probe.ts:714-722`. Tests `probe.test.ts:344-441, 503-554`. |
| Dry-run zero transport/usage/key | holds | `live = options.live === true && options.dryRun !== true` `probe.ts:398`; dry-run returns before transport/liveUsage destructuring and key read `probe.ts:456-465`. Test `probe.test.ts:92-116` uses a nonexistent key path. |
| No credential/sensitive payload in result | holds | records carry no headers/bodies (`probe.ts:629-646`); test `probe.test.ts:636-655` asserts the serialized result lacks the key and the string `authorization`. Transport-error text carries only error messages. |
| CLI rejects malformed budgets | holds | `positive()` throws on NaN/∞/≤0 `probe-cli.ts:19-26`; `parseLevels`/`parseMode` throw on malformed levels/modes `probe-cli.ts:28-55`; live requires `--live` + `MORPH_PROBE_ALLOW_LIVE=1` else exit 2 `probe-cli.ts:57-61`. |

## Calibration / unique-body overshoot of assumed caps (explicit check)

- Cold start `charsPerToken = 4` (`probe.ts:410`), safety 0.9 (output) / 1.02 (input)
  (`probe.ts:348`). With the default ordering the first call is an output-sweep body
  of 2000×4×0.9 = 7 200 chars ≈ 2.4–2.9 k real tokens vs the 2 k the admission
  assumed — negligible against the 240 k/32 k caps, and the ratio is re-measured from
  the very first response (`probe.ts:660-663`).
- The ascending input levels (50k → 100k → 200k) therefore run on a measured ratio;
  the 200 k level never runs on the cold-start guess with default levels. Expected
  total spend ≈ 1.1 M tokens < `maxTokens` 2 M, and 30 calls ≥ the 18 minimum
  successes + retries. The default protocol does not overshoot the assumed caps.
- Residual (operator exposure, not defaults): a custom `--levels` run starting at a
  large input level on a fresh process is admitted on the planned `level.input` while
  the 4 c/t guess can overshoot ~1.5–2× (e.g. 200 k planned → ~300–400 k actual at
  ~2–2.7 c/t), breaching `assumedCaps` once. The overshoot lands in the sliding
  window, so every subsequent admission fails closed for 60 s (`probe.ts:501-511`)
  and `maxTokens` bounds the total. The code never treats reported tokens as
  pre-flight protection — admission is planned-level + measured-window based, as
  required. A future live run should keep the default ascending order.

## Reproduced defects (offline harness, /tmp, not committed)

### D1 (gating): missing live-load window fields are admitted as zero load — fail-open

`probe.ts:497-500`:

```ts
const liveTotals = {
  uncachedIn: Number(group.window?.uncached_in ?? 0),
  out: Number(group.window?.out ?? 0),
};
```

A matched group whose `window`/fields are absent (malformed or version-skewed local
usage endpoint) is treated as zero live load and admitted. Reproduction: live usage
returns `{ groups: { g: { models: ['morph-test'] } } }` (window absent), caps sized so
that only zero live load admits → transport was called once, run concluded
`completed`. NaN load, by contrast, refuses (0 calls, `deadline`). The invariant
pairs "missing/NaN": NaN is fail-closed, missing is not. The shipped pacer always
emits numeric windows (`pacer.ts:301-317`), so the reachable trigger is endpoint
skew/misconfiguration — exactly the condition a fail-closed guard exists for.
Fix direction: coerce absent/null/non-finite window values to a refusal
(`live_usage_unavailable`), same class as the missing-group path.

### D2 (minor): negative completion_tokens are accepted unclamped

`probe.ts:643` clamps `uncachedIn` (`probe.ts:642`) but not `out`; `usedTokens`
(`probe.ts:667`) and the probe window (`probe.ts:670`) then decrease. Reproduction:
provider answers `completion_tokens: -5` on an input level → each of 5 attempts adds
−5 → window `{ uncachedIn: 500, out: -25 }`, admission's output total eroded. A
negative `out` can never meet a threshold, so no false success is possible; this only
softens the admission guard, and requires a provider that lies about usage. Fix
direction: `Math.max(0, ...)` at `probe.ts:643` or reject negative usage as
`missing_usage`.

### D3 (minor, unreachable with defaults): fully-completed run reported as `budget`

`probe.ts:692-699` checks the token cap immediately after a success, before the
`while` condition can observe `successes == successesPerLevel`. If the cap is reached
exactly on the final success of the final level, a run in which every level met its
actual threshold concludes `budget`, `tested: false`, exit 1. Reproduction: one level,
`successesPerLevel: 1`, `maxTokens: 50`, usage 30+30 → outcome `success`, conclusion
`budget`. Defaults need ≈1.1 M of 2 M tokens, so this needs deliberately tight custom
limits. Underclaim-only; fix direction: skip the budget return when no further call
is needed.

## Focused offline verification

- `npx tsx --test morph-pacer/tests/probe.test.ts` → 23/23 pass.
- `npx tsc --noEmit -p morph-pacer/tsconfig.json` → clean.
- `npx oxlint` on `probe.ts`, `probe-cli.ts`, `probe.test.ts` → 0 warnings, 0 errors.
- No full gate run. No live call. `git status` clean except this report.

## Verdict

**HOLD.** D1 is a reproduced violation of the stated "missing/NaN load fail-closed"
admission invariant; per the job contract no live DeepSeek invocation is provided.
The measurement-integrity core of f81be927 (actual-token thresholds, inconclusive
below-threshold, unique bodies, honest conclusions, dry-run and secret hygiene)
verifies clean, and D1/D2/D3 are one-line-scale fixes; once D1 lands, this reviewer's
remaining checks would not block preparing the bounded live protocol
(`--max-total-ms ≤ 1_080_000`, default ascending levels, `--live` +
`MORPH_PROBE_ALLOW_LIVE=1`).
