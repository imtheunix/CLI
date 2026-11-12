# Job d47c88a1 — offline verify Morph probe guards before live use

Fresh independent offline review of `5402fa02` (bounded offline-first usage probe) as merged into main: `morph-pacer/src/probe.ts`, `morph-pacer/src/probe-cli.ts`, `morph-pacer/tests/probe.test.ts`. No live request, no key access, no env or service mutation. Evidence: code read + offline tests.

## Verdict: PASS

All 11 guard checks hold. `npm run test:morph-pacer`: 57/57 pass. `tsc --noEmit -p morph-pacer/tsconfig.json`: clean. `oxlint` on the three reviewed files: 0 warnings.

## Checklist findings

1. **Dry-run default** — PASS. Live requires `options.live === true && options.dryRun !== true` (`probe.ts:294`); the CLI needs both `--live` and `MORPH_PROBE_ALLOW_LIVE=1`, else exit 2 (`probe-cli.ts:29-33`). The key file is read only after the dry-run early return (`probe.ts:328-346`). Test: `probe.test.ts:83` (zero transport/usage calls, no key touch).
2. **Key exposure** — PASS. The key lives only in the `authorization` header (`probe.ts:434-437`); `ProbeResult`/`ProbeCallRecord` never carry headers or the key; CLI prints only the result JSON (`probe-cli.ts:50`); error strings name the path, never the key (`probe.ts:272,344,458`).
3. **Direct endpoint** — PASS. Constant `https://api.morphllm.com/v1/chat/completions` (`probe.ts:7`), asserted in `probe.test.ts:137`; usage is a GET against the local pacer only (`probe.ts:8,105-115`).
4. **Serialization / no retries** — PASS. One awaited request at a time (`probe.ts:392-574`); transport errors, 5xx and missing-usage all stop immediately (`probe.ts:441-470,502-515,563-573`). The only retry is the bounded 429 wait. `probe.test.ts:148-171` proves the refused second call is "not piled onto live work".
5. **Scoped input AND output increase** — PASS. Admission requires both `combined.uncachedIn + level.input <= caps.uncachedIn × headroom` and the same for output (`probe.ts:376-381`).
6. **Combined sliding-60s accounting** — PASS. Probe window is `RollingWindow(60_000)` fed with exact response usage (`probe.ts:296,518-522`); live side is the pacer's own sliding 60s window via `/pacer/usage` (`proxy.ts:156-158`, `pacer.ts:87`); combined at admission (`probe.ts:367-375`) and in the result (`probe.ts:314-323`). A malformed snapshot yields NaN, which fails every comparison → poll to deadline, fail-closed.
7. **Live admission fail-closed** — PASS. Usage fetch throws → `live_usage_unavailable` before any request (`probe.ts:359-364`, `probe.test.ts:367`); no model group → `load_guard` before any request (`probe.ts:365-366`); deadline → stop (`probe.ts:358`).
8. **Exact required response usage** — PASS. 2xx without parseable usage halts as `missing_usage`, nothing counted, no invented numbers (`probe.ts:502-515`, `probe.test.ts:271`); uncached in is `max(0, prompt_tokens − cached_tokens)` from the response (`probe.ts:495`).
9. **Request/deadline/caps** — PASS. 120s per-request abort via AbortController (`probe.ts:72-90,439`); deadline checked at loop top, in the admission loop, and before any Retry-After wait that would pass it (`probe.ts:358,393,546-558`); caps 240k in / 32k out (`probe.ts:21`).
10. **Two-consecutive-429** — PASS. Counter persists across levels, reset only on success (`probe.ts:299,524,533`); two in a row → `repeatable_limit`, `tested: true`, honest note (`probe.ts:534-544`, `probe.test.ts:198`).
11. **Retry-After / below-cap-429 not a ceiling** — PASS. Retry-After parsed (seconds or HTTP-date, clamped ≥ 0) and honored under deadline guard (`probe.ts:233-244,546-559`); a non-repeatable 429 followed by success sets `belowLimit429` and the note says "not a ceiling claim" (`probe.ts:580-582`, `probe.test.ts:238`); `capacity_error`/`transport_error` notes also disclaim ceiling claims; every stop-short conclusion has `tested: false`.

## Non-blocking notes (no fix required for live use)

- `probe-cli.ts:46`: `Number(arg('--max-total-ms') ?? …)` on a garbage value yields NaN → the deadline never trips and the admission poll collapses to a near-tight loop on the local usage endpoint (still fail-closed: no provider request until admission passes). Minimal hardening if desired: reject non-finite `--max-total-ms`.
- `probe.ts:341`: an explicitly empty `apiKey: ''` bypasses the file fallback (`??` is nullish-only). CLI path always uses the file; harmless today.
- A 429↔success ping-pong is bounded only by the 20-minute deadline — by design and fail-safe.

## Exact safe DeepSeek live invocation (≤ 20 min)

Prerequisite: the pacer service must be running so `http://127.0.0.1:8198/pacer/usage` answers; avoid other heavy Morph traffic during the run. Run from a repo checkout:

```sh
MORPH_PROBE_ALLOW_LIVE=1 npx tsx morph-pacer/src/probe-cli.ts \
  --live --model morph-dsv41flash-1017 --max-total-ms 1200000
```

Everything else is the reviewed default: direct Morph endpoint, key from `~/.config/morph/api_key`, caps 240k uncached-in / 32k out, levels 60k/8k → 120k/16k → 240k/32k with 3 successes each, 120s request timeout, 20-minute deadline. Exit code 0 only on `completed`; any guard stop exits 1, so it is safe to script around.
