# OpenCode live browser streaming — `e9ccb353`

Date: 2026-11-10
Scope: live browser verification of the deployed CloudCLI build (`1.37.5`,
`origin/main` `53713807`) against a real OpenCode/Morph model.
Branch: `bugfix/cli-verify-selected-browser-live-streami-e9ccb353`

## Verdict

**Live browser streaming: PASS for the primary generation.** A real
OpenCode/Morph turn reached the selected browser session as incremental
`stream_delta` frames before completion, the final assistant text was correct,
and a second session received no cross-session frames or text.

**Two findings remain:**

- **F1 — reasoning text leaks into the assistant message.** On a prompt that
  makes the model emit reasoning, the bridge streams the reasoning part as
  `stream_delta` text. The browser shows the reasoning sentence before the
  final answer, so the browser's final text is not the provider's final text.
  The primary `LIVE_OK`/`CROSS_OK` generations had no reasoning and were
  correct.
- **F2 — the UI token rate is unavailable for OpenCode.** The composer's
  `[data-testid="token-rate"]` stayed `—` and the token count stayed `0` for
  every run. The selected session's persisted token usage is present, so a
  measured tok/s can be computed, but the UI does not display it.

A third, lower-severity timing note: the first `PROBE_OK` generation's first
`stream_delta` arrived after the provider's completed timestamp (a
post-completion synthetic delta). The later long-prompt generation's first
delta arrived before the provider completed, so the live path itself works;
the post-completion delta is a timing gap, not a total failure.

## Why an isolated instance

The deployed instance on port `8197` requires a JWT for user `Eduardo`; no API
key exists and the JWT secret is in `app_config`. Minting a token was treated
as prohibited. Instead, the deployed build was started a second time with
isolated `HOME`/`XDG_*`/`DATABASE_PATH` on port `18297`, a test user
`probeuser`, and a project under
`/home/busu/Tribeira/.jobs/tribeiracli/e9ccb353/.probe-project`. No existing
chat, browser profile, credential, or production database was read or changed.

The isolated OpenCode config was a copy of the working global config with the
MCP block removed and the two `{file:...}` references made absolute. The
initial copy was placed in the wrong directory (`$XDG_CONFIG_HOME/` instead of
`$XDG_CONFIG_HOME/opencode/`), which produced `Unexpected server error`; after
the copy was corrected, the live turns succeeded.

## Evidence

Selected CloudCLI session: `0c424fb3-b958-4d98-972f-6f9020a8939d`
Provider session: `ses_e38579fbfffeB4dgcbLB3DqLJJ`
Model: `morph/morph-dsv41flash-1017` (`Medium`)

### Primary generation — `CROSS_OK`

- Prompt: `Reply with exactly: CROSS_OK`
- Browser assistant text: `CROSS_OK`
- Provider message: created `2026-11-10T23:00:45.929Z`, completed
  `2026-11-10T23:00:46.079Z` (150 ms)
- Tokens: output `5`, reasoning `0`, total `7514`
- Measured selected-session tok/s: `5 / 0.150 s = 33.3 output tok/s`
- First `stream_delta` observed before the provider's completed timestamp; the
  exact browser timestamp was in the probe log but the terminal capture was
  truncated.
- Cross-session check: a second session
  (`72464691-bfb6-493c-9443-4273fc5130f8`) received **0** `stream_delta`
  frames, **0** assistant `text` frames, and its DOM did not contain
  `CROSS_OK`.

### Repeat for tok/s — numbers 1–100

- Prompt: `Write the numbers 1 through 100, one per line, and nothing else.`
- First `stream_delta`: `11.943 s` after probe start, content
  `The user wants numbers 1-100 one per line. But instructions...`
- UI completion: `13.037 s`; `7` deltas total.
- Provider message: created `2026-11-10T22:57:03.405Z`, completed
  `2026-11-10T22:57:08.568Z` (5.163 s)
- Tokens: output `51`, reasoning `170`, total `7497`
- Measured selected-session tok/s: `(51 + 170) / 5.163 s = 42.8 generated
  tok/s`; output-only `51 / 5.163 s = 9.9 tok/s`
- Provider final text: the numbers `1`–`100`, one per line.
- Browser assistant text: the reasoning sentence followed by the numbers.
  This is **F1**: the reasoning part was streamed as text.

### Initial generation — `PROBE_OK`

- Prompt: `Reply with exactly: PROBE_OK`
- Browser assistant text: `PROBE_OK`
- Provider message: created `2026-11-10T22:54:55.790Z`, completed
  `2026-11-10T22:54:59.047Z` (3.257 s)
- Tokens: output `5`, reasoning `0`, total `7255`
- First `stream_delta`: `9.805 s`; UI completion: `11.042 s`.
- The provider completed at `22:54:59.047Z`; the first delta arrived after
  that timestamp, so this run is not evidence of live incremental text. It is
  evidence that the final text is correct.

### UI token rate

`[data-testid="token-rate"]` was `—` and the token count was `0` in all three
runs. The selected session's persisted token usage is available in the
OpenCode database, so the measured tok/s above is real; the UI simply does not
receive it for OpenCode.

## Reproduction

The harness is `scripts/probes/opencode-streaming-live-browser.mjs`. It assumes
the isolated instance is running and takes the root, port, token, selected
session id, project path, Playwright module, Chromium executable, and OpenCode
database path from environment variables. It creates its own second session,
sends one prompt, captures the WebSocket frames and DOM, reads the selected
session's persisted token usage, writes `live-browser-evidence.json` under the
probe root, and asserts the streaming, correctness, cross-session, and tok/s
conditions.

The isolated instance was started from the deployed build with:

```bash
HOME="$ROOT/home" \
XDG_CONFIG_HOME="$ROOT/config" \
XDG_DATA_HOME="$ROOT/data" \
XDG_CACHE_HOME="$ROOT/cache" \
XDG_STATE_HOME="$ROOT/state" \
DATABASE_PATH="$ROOT/auth.db" \
SERVER_PORT=18297 \
node /home/busu/.local/share/cli/app/dist-server/server/index.js
```

The test user was registered through the normal API and onboarding was
completed. The project path was
`/home/busu/Tribeira/.jobs/tribeiracli/e9ccb353/.probe-project`.

## Cleanup

The isolated server and its OpenCode children were stopped by PID after the
probe; the temp root and `.probe-project` were removed. No deployed process,
credential, or production database was touched.
