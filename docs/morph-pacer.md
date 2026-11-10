# morph-pacer

A small local proxy in front of Morph's OpenAI-compatible API. It keeps our agents inside Morph Ultra's per-minute token caps, so they use the capacity fully without getting a 429 from going over it.

It listens on `127.0.0.1:8198`, forwards `/v1/*` to `https://api.morphllm.com/v1/*`, and injects the key from `~/.config/morph/api_key`. Client `Authorization` headers are ignored. Streaming responses pass through unbuffered; for streams it adds `stream_options.include_usage=true` when the request does not set it.

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
