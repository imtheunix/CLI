# OpenCode streaming bounded refutation — `1ae54ca3`

Date: 2026-11-10
Scope: independent offline verification of the merged OpenCode live-delta bridge
(`opencode-bridge.ts`, `opencode-runtime.provider.js`) without a remote model.
Branch: `bugfix/cli-check-opencode-streaming-with-bounde-f8b23469`

## Verdict

**Offline SDK/protocol streaming: PASS.** The real bridge process and the real
turn-line parser were exercised against a local event feed using the exact
`{ id, type, properties }` envelope and `message.part.delta` field paths that
the installed OpenCode 1.19.4 binary defines. Incremental text reached the
selected provider session before the completed stdout part, other-session
events were filtered, replayed JSON event ids were suppressed, and the
stdout-fallback / disconnect / stall / cancellation paths were bounded and
cleaned up.

**Actual live model generation: NOT VERIFIED.** No external model or credential
was used. This report does not claim that a real provider token arrives; it
claims that the SDK-event/client and subscription lifecycle are correct. The
remaining isolated browser/live latency check is still required.

The cancelled GLM review `3111384d` is **not** treated as evidence of a product
defect. Its archived capture contains only one `server.connected` frame and no
pass/fail or byte evidence; its cause was never established.

## Source and event-shape evidence

Installed binary: `/home/busu/.opencode/bin/opencode` (`opencode --version` =
`1.19.4`).

Binary schema strings confirm:

- Event envelope: `{ id, type, properties }` (e.g. `Qc({id:sf(),type:"server.connected",properties:{}})`).
- `server.connected` schema: `{}`.
- `message.part.delta` schema: `{ sessionID, messageID, partID, field, delta }`.
- `session.next.text.delta` also exists and is handled by the bridge.

Bridge correlation (`server/modules/providers/list/opencode/opencode-bridge.ts`):

- `readDelta` reads `properties.sessionID`, `properties.messageID`,
  `properties.partID`, `properties.field === 'text'`, `properties.delta` for
  `message.part.delta`; and `sessionID` / `assistantMessageID` / `textID` /
  `delta` for `session.next.text.delta`.
- `handleSseEvent` uses the JSON body `id` first, then the SSE `id:` field, for
  replay suppression (`seenEventIds`).
- Selected-session filtering compares `delta.sessionId` with `targetSessionId`
  (from `--session`, or learned from run stdout and then flushed from the
  bounded buffer).
- `completedTextPartIds` suppresses late deltas for a part whose completed text
  already arrived on authoritative run stdout.

Parser (`server/modules/providers/list/opencode/opencode-runtime.provider.js`):

- `streamedTextByPart` accumulates live deltas per part.
- A completed part that extends the streamed prefix emits only the remainder.
- After `stream_reset`, only bridge-marked synthetic deltas (`bridge: true`) are
  dropped; authoritative flat stdout deltas are still accepted.
- A divergent completed part cannot be retracted by the normalized protocol;
  the parser emits the authoritative text and the client may see both. This is
  a documented limitation, not a regression introduced by `1ae54ca3`.

## Commands and results

### Focused existing tests

```bash
npx tsx --tsconfig server/tsconfig.json --test \
  server/modules/providers/list/opencode/opencode-runtime.provider.test.js
```

Result: **31 tests, 31 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo**
(duration ~27.3 s).

### Independent probe

```bash
npx tsx --tsconfig server/tsconfig.json \
  scripts/probes/opencode-streaming-bounded.mjs
```

Result: **7 probes passed** (~4.8 s). Probe steps:

1. `real-server-envelope` — started the real installed `opencode serve` with
   isolated `HOME` and `XDG_{CONFIG,DATA,CACHE,STATE}_HOME` under a temp dir and
   a temp workdir; connected to `/event`; received
   `{"id":"evt_…","type":"server.connected","properties":{}}` within 5 s.
2. `real-server-lifecycle` — aborted the subscription, sent `SIGTERM`, and the
   real server exited within 5 s.
3. `incremental` — real bridge + real parser against a local fake event server
   emitting real-shaped frames:
   - `evt_d1` `ses_A` `Hel`
   - `evt_other` `ses_B` `LEAK`
   - duplicate `evt_d1` `ses_A` `Hel`
   - `evt_d2` `ses_A` `lo`
   - `message.part.updated` `ses_A` completed `Hello`
   - `session.idle` `ses_A`

   The fake run waited for a marker written only after the probe observed the
   second delta, then emitted the completed stdout part. Result:
   `stream_delta = ["Hel","lo"]`, exactly 2 raw delta lines, no `LEAK`, no
   duplicate `Hello` text, deltas timestamped before the completion line,
   bridge exit 0, serve child dead.
4. `stdout-fallback` — fake serve fails at startup; bridge falls back to an
   ordinary run whose flat stdout deltas are `Hel`, `lo` followed by completed
   `Hello`. Result: `stream_delta = ["Hel","lo"]`, 0 duplicate `Hello` texts,
   bridge exit 0.
5. `disconnect-fallback` — fake serve sends `server.connected` then destroys
   the response. Result: one `stream_reset`, completed text `["Hello"]` exactly
   once, bridge exit 0.
6. `stall-bounded` — fake serve sends only `server.connected` and keeps the
   connection open; the run completes after a bounded 300 ms. Result: bridge
   exited in ~1.2 s, serve child dead. No indefinite SSE wait.
7. `cancellation-cleanup` — same stall feed, then `SIGTERM` after both fake
   serve and fake run PIDs exist. Result: bridge exited in ~0.9 s, both owned
   children dead within the 2 s cleanup timeout.

### Typecheck / lint

```bash
npx tsc --noEmit -p server/tsconfig.json   # exit 0
npx oxlint scripts/probes/opencode-streaming-bounded.mjs  # exit 0
```

## Cancelled review `3111384d` cleanup

The archived evidence `/tmp/opencode/sdk-review-3111384d-sse-capture.txt`
contains no PID or worktree path. A targeted check of `opencode serve`
processes found no process whose cwd/PID belongs to `3111384d`; the only
matches were the probe's own transient shell. No orphan was killed. If an
orphan from that review still exists, its ownership is not demonstrable from
the preserved evidence, so cleanup is **unable to verify** rather than guessed.

## Remaining gap

- No live provider/model token arrival was tested. The probe validates the
  installed OpenCode event envelope, the bridge's SSE parsing/subscription
  lifecycle, selected-session correlation, replay suppression, fallback and
  cleanup. It does not validate remote model latency or a real provider's
  token stream.
- The isolated browser/live latency check remains separate.
- The divergent-completion case can still show both the streamed prefix and
  the authoritative text; the normalized protocol has no replace/rewind event.
  This is documented by the existing test and is not a new defect.
