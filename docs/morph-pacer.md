# morph-pacer

A small local proxy in front of Morph's OpenAI-compatible API. It keeps our agents inside Morph Ultra's per-minute token caps, so they use the capacity fully without getting a 429 from going over it.

It listens on `127.0.0.1:8198`, forwards `/v1/*` to `https://api.morphllm.com/v1/*`, and injects the key from `~/.config/morph/api_key`. Client `Authorization` headers are ignored. Streaming responses pass through unbuffered; for streams it adds `stream_options.include_usage=true` when the request does not set it.

`POST /v1/messages` (the Anthropic wire) is passed through too. It uses the same model aliases, pacing groups and ledger, with Anthropic usage mapped as `input_tokens + cache_creation_input_tokens` uncached input, `cache_read_input_tokens` cached input and `output_tokens` output. Verified 2026-11-11: Morph's `/v1/messages` ignores `chat_template_kwargs`, so aliases there map the model only; the Kimi thinking-off alias stays on `/v1/chat/completions`. OpenAI-only injections (`cache_ttl`, `run_id`, `stream_options`) are not added to `/v1/messages`.

## Run it

```sh
npx tsx morph-pacer/src/index.ts
```

The process is standalone: it is not part of the cloudcli server, so restarting cloudcli never cuts a model call.

## Point OpenCode at it

In `~/.config/opencode/opencode.jsonc`, change the Morph provider's `baseURL` from `https://api.morphllm.com/v1` to the proxy:

```jsonc
"morph": {
  "npm": "@ai-sdk/openai-compatible",
  "name": "Morph",
  "options": {
    "baseURL": "http://127.0.0.1:8198/v1",
    "apiKey": "{file:~/.config/morph/api_key}"
  },
  "models": { /* unchanged */ }
}
```

The proxy reads the key itself, so the `apiKey` option can stay as it is. Do not point anything else at port 8198; it is a local-only listener.

## Caps and config

Defaults match Morph Ultra:

| Group | Models | Uncached input / min | Output / min |
|---|---|---|---|
| `kimik31` | `morph-kimik31` | 72,870 | 6,162 |
| `deepseek` | `morph-dsv41flash`, `morph-dsv41flash-1017` | 2,103,237 | 76,559 |

Cached input counts toward neither cap. Reasoning tokens count as output. The two DeepSeek ids share one budget.

Override anything in `~/.config/morph-pacer/config.json`:

```json
{
  "port": 8198,
  "upstream": "https://api.morphllm.com/v1",
  "apiKeyFile": "~/.config/morph/api_key",
  "headroom": 0.95,
  "maxWaitMs": 120000,
  "maxRetries": 6,
  "ledgerPath": "~/.local/state/morph-pacer/ledger.jsonl",
  "ledgerMaxBytes": 52428800,
  "groups": {
    "kimik31": {
      "models": ["morph-kimik31"],
      "caps": { "uncachedIn": 72870, "out": 6162 }
    },
    "deepseek": {
      "models": ["morph-dsv41flash", "morph-dsv41flash-1017"],
      "caps": { "uncachedIn": 2103237, "out": 76559 }
    }
  }
}
```

`headroom` is the fraction of each cap the proxy is willing to use. `maxWaitMs` is the longest a request is delayed for budget; after that it is forwarded anyway and a warning is logged. A request is never rejected for budget.

## Admission

Before forwarding, the proxy reserves both an estimated uncached input and an estimated output for the request. The input estimate is conservative: `ceil(bodyBytes / 4)`, at least 512 tokens, so a burst of large prompts cannot all pass admission at once. The output estimate is the per-model rolling p75 of recent completions, at least 256 tokens. Requests wait in FIFO order per model group until the 60-second window plus reservations fits under `cap * headroom`. When the response ends, the reservation is replaced by the real usage. If the upstream began but the response carries no usage (or the client aborts mid-stream), the reserved estimate is kept in the window instead of accounting zero, so the next admission stays conservative.

Upstream `429` and `503` responses are retried transparently up to six times. `Retry-After` is honored; otherwise the delay is exponential with jitter, between 1 and 60 seconds.

## Ledger and usage

Every completed request appends one JSON line to `~/.local/state/morph-pacer/ledger.jsonl`:

```json
{"ts":"2026-11-10T09:00:00.000Z","model":"morph-kimik31","uncached_in":80,"cached_in":20,"out":50,"reasoning":10,"status":200,"wait_ms":0,"retries":0,"stream":false}
```

The file rotates to `ledger.jsonl.1` at 50 MB.

`GET http://127.0.0.1:8198/pacer/usage` returns the current 60-second window, caps, reservations, queue length and 429s in the last hour for each model group.

## systemd user unit

The unit file is `morph-pacer/morph-pacer.service`. It assumes the repository is at `~/Tribeira/tribeiracli`; adjust `WorkingDirectory` and `ExecStart` if yours is elsewhere.

```sh
mkdir -p ~/.config/systemd/user
cp morph-pacer/morph-pacer.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now morph-pacer
```

Check it with `systemctl --user status morph-pacer` and `curl http://127.0.0.1:8198/pacer/usage`.

## Guarded ceiling probe

`morph-pacer/src/probe.ts` is an offline-testable, guarded measurement tool for the real
per-minute input/output ceilings. It is **disabled by default**: without `--enable-live` it
prints a `disabled` report and makes no network call. It never retries a request, keeps one
request in flight, and uses only deterministic synthetic prompts (no workspace or customer
data).

The key is read in-process from `~/.config/morph/api_key` (or `--api-key-file`). It is never
accepted as an argument, printed, logged or written to the report; only the outbound
`Authorization` header carries it.

Before every call the probe reads `GET http://127.0.0.1:8198/pacer/usage` with a timeout and
fails closed when live occupancy is unavailable or above the configured guard. Because direct
requests bypass the pacer, the probe keeps its own 60-second rolling window and records
`live_occupancy`, `probe_occupancy`, the per-call `reservation` and `combined_occupancy` for
every call. It stops on the deadline, any token/call cap, a second consecutive 429, absent
usage, transport uncertainty, or the live-load guard.

Input is measured first, then output. Each step needs three successes before the next step is
tried. A 429 below the proposed ceiling is classified `ceiling_not_explanatory`; a threshold is
only called explanatory with repeatable evidence (two 429s at or above the proposed ceiling).
The report never claims measured capacity.

### Safe DeepSeek invocation

```sh
npx tsx morph-pacer/src/probe-cli.ts \
  --enable-live \
  --model morph-dsv41flash-1017 \
  --group deepseek \
  --deadline-ms 1200000 \
  --max-calls 60 \
  --max-input-tokens 8000000 \
  --max-output-tokens 200000 \
  > /tmp/morph-deepseek-probe.json
```

Hard caps are the four flags above (20 minutes, 60 calls, 8M input tokens, 200k output
tokens). The per-request caps are 2,000,000 input tokens and 65,536 output tokens. The live
guard fails closed at 50% of the group cap. Run the Kimi measurement as a separate invocation
with `--model morph-kimik31 --group kimik31` and the same caps.

### Report schema (`morph-ceiling-probe/v1`)

```json
{
  "schema": "morph-ceiling-probe/v1",
  "status": "disabled | completed | stopped",
  "stopReason": "disabled | completed | deadline | call_cap | input_token_cap | output_token_cap | live_usage_unavailable | live_load_guard | two_consecutive_429 | missing_usage | transport_uncertainty | http_error | missing_api_key",
  "model": "morph-dsv41flash-1017",
  "group": "deepseek",
  "startedAt": "ISO-8601",
  "endedAt": "ISO-8601",
  "caps": { "maxCalls": 60, "maxInputTokens": 8000000, "maxOutputTokens": 200000, "deadlineMs": 1200000 },
  "guard": { "maxLiveUncachedIn": 1000000, "maxLiveOut": 30000, "maxCombinedUncachedIn": 1500000, "maxCombinedOut": 50000 },
  "proposedCeiling": { "input": 2103237, "output": 76559 },
  "calls": [
    {
      "index": 1,
      "phase": "input | output",
      "step": 1,
      "targetInputTokens": 1024,
      "targetOutputTokens": 16,
      "maxTokens": 16,
      "promptBytes": 1234,
      "status": 200,
      "retryAfterMs": null,
      "provider429": false,
      "ceilingNotExplanatory": false,
      "usage": { "inputTokens": 1000, "outputTokens": 10, "cachedTokens": 0, "uncachedInputTokens": 1000 },
      "liveOccupancy": { "uncachedIn": 0, "out": 0 },
      "probeOccupancy": { "uncachedIn": 0, "out": 0 },
      "reservation": { "uncachedIn": 512, "out": 16 },
      "combinedOccupancy": { "uncachedIn": 512, "out": 16 },
      "pacerWaitMs": 0,
      "providerWaitMs": 10,
      "outcome": "success | provider_429 | missing_usage | transport_error | http_error",
      "error": null
    }
  ],
  "summary": {
    "totalCalls": 1,
    "totalInputTokens": 1000,
    "totalOutputTokens": 10,
    "totalUncachedInputTokens": 1000,
    "provider429Count": 0,
    "input": { "successes": 1, "maxSuccessTarget": 1024, "maxSuccessActualInput": 1000, "maxSuccessActualOutput": 10, "rateLimits": 0, "ceilingExplanatory": null },
    "output": { "successes": 0, "maxSuccessTarget": null, "maxSuccessActualInput": null, "maxSuccessActualOutput": null, "rateLimits": 0, "ceilingExplanatory": null },
    "pacerWaitMsTotal": 0,
    "providerWaitMsTotal": 10
  }
}
```

`pacerWaitMs` is the time spent reading live occupancy and applying the guard before a call;
`providerWaitMs` is the request latency. `retryAfterMs` is the provider's `Retry-After` value
when present. These are measurements, not conclusions.
