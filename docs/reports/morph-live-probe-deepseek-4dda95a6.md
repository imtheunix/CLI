# First bounded live Morph probe: DeepSeek 1017 (4dda95a6)

Raw secret-free result: `docs/reports/morph-live-probe-deepseek-4dda95a6.json`.

## Invocation

```
MORPH_PROBE_ALLOW_LIVE=1 npx tsx morph-pacer/src/probe-cli.ts \
  --live --model morph-dsv41flash-1017 --max-total-ms 1200000
```

Used the merged, offline-reviewed probe (5402fa02): direct
`https://api.morphllm.com/v1/chat/completions`, in-process key read from
`~/.config/morph/api_key` (never printed), synthetic prompts, one request in
flight, no transport retries, every default guard, and the explicit 1,200,000 ms
deadline. Only this model ran; no Kimi calls.

The run stopped on its own at `conclusion.kind = "completed"`: all three planned
levels with the required three successes each. No 429, no capacity error, no
deadline stop, no missing usage, no transport error. Actual provider latency
totalled about 25.7 s; the 20-minute deadline was never approached.

## Requests and actual usage

Nine requests, all HTTP 200 (3 per level). `uncachedIn = prompt_tokens - cached_tokens`.
No `Retry-After` was ever present because no request was rate-limited.

| level | planned in/out | call | prompt_tokens | uncachedIn | completion_tokens | latency ms |
|---|---|---|---|---|---|---|
| 0 | 60,000 / 8,000 | 1 | 53,371 | 49,275 | 13 | 2,862 |
| 0 | | 2 | 53,371 | 53,371 | 13 | 1,820 |
| 0 | | 3 | 53,371 | 123 | 13 | 1,821 |
| 1 | 120,000 / 16,000 | 1 | 106,704 | 53,456 | 13 | 2,282 |
| 1 | | 2 | 106,704 | 52,432 | 13 | 3,446 |
| 1 | | 3 | 106,704 | 208 | 13 | 3,017 |
| 2 | 240,000 / 32,000 | 1 | 213,371 | 379 | 13 | 5,110 |
| 2 | | 2 | 213,371 | 379 | 13 | 2,327 |
| 2 | | 3 | 213,371 | 379 | 13 | 3,046 |

Two facts matter for interpretation:

- The synthetic prompt targets characters at 4 chars/token, so the provider
  actually tokenised 53,371 / 106,704 / 213,371 prompt tokens, not the planned
  60k / 120k / 240k. The "240k" level was, in provider-token terms, a request of
  213,371 prompt tokens.
- Every successful response returned 13 completion tokens. `max_tokens` was set
  to 8,000 / 16,000 / 32,000, but the prompt asks for the single word `OK`, so
  the provider returned a tiny completion. The run therefore never generated
  8k, 16k or 32k of output.

Repeated identical prompts were served largely from prompt cache in later calls
(uncachedIn falls to 123, 208 and 379), which is why uncached input is much
smaller than prompt_tokens at those calls. The uncached figures are measured,
not assumed.

## Occupancy and safety

- Probe rolling-60s window at the end: 379 uncached in / 13 out.
- Live pacer window at the end: 0 / 0; it was 51,325 / 1,196 at the first call
  and 7,005 / 606 at the first level-1 call before rolling off.
- Combined occupancy therefore stayed far below the probe's assumed caps
  (240,000 uncached in / 32,000 out) whenever a request was admitted.
- Live admission never had to deny a request in this run; the in-process
  accounting of concurrent live Morph traffic behaved as designed and the
  pacer itself was not touched.

## What this run establishes, and what it does not

Established:

- The provider endpoint accepted nine sequential single requests for
  `morph-dsv41flash-1017` with no 429, capacity error or transport failure.
- Requests carrying up to 213,371 actual prompt tokens were accepted, three
  times at the top level.
- A request parameterised with `max_tokens = 32,000` was accepted.

Not established:

- No provider input or output ceiling. A completed run with zero 429s is
  evidence of acceptance, not of any limit. It says nothing about where a
  ceiling lies, including whether one exists near the assumed 240k / 32k.
- No output ceiling at 8k, 16k or 32k: only 13 output tokens came back each
  time, so real output volume was never exercised.
- The 60k / 120k / 240k input levels were not reached in provider tokens
  (53,371 / 106,704 / 213,371 actual), and later calls were mostly cache hits.
- No below-cap 429 and no repeatable-limit (two consecutive 429) evidence was
  observed, so no threshold can be reported. Published provider limits are not
  used as a claim.
