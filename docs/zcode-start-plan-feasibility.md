# ZCode Start Plan headless feasibility

Spike: 2026-11-06, job 676ca0a8. Upstream ZCode commit
`a9fe401eede6e6e5e01be9048679c206fe6f02d9` (3.17.2).

## Build evidence

The official TUI/Web/Agent distribution builds from source with Node 24.14.0
and pnpm 10.33.2. A clean `pnpm build:zcode` initially fails during TUI staging:
`Missing @zcode/shared dist files. Run \`pnpm build\` before \`pnpm sea\`.`
Running `pnpm exec tsc -b packages/shared` supplies the missing output; rerunning
with `ZCODE_ENV=production` builds the complete distribution successfully.

All build/runtime artifacts live in `/tmp/zcode-spike-676ca0a8/`;
`ZCODE_DIST_HOME` and `ZCODE_DIST_BIN_DIR` select its separate runtime and bin
prefixes. The existing `~/.local/bin/zcode` is not overwritten. Login data must
be shared with the server to reuse the existing OAuth session; credentials
are neither inspected nor included here.

## Live probe checkpoint

The separate-prefix installer succeeded. Started the official runner with
`ZCODE_ENV=production zcode --web --no-open --host 127.0.0.1 --port 39367
--workspace /tmp/zcode-spike-676ca0a8/workspace` (one command). HTTP server-info
reported version 3.17.2, protocolVersion 1, authRequired false, WebSocket RPC
available, and zero failed storage migrations.

The binary RPC client connected to `/ws`. Requested selection was exactly
`{providerId:"account:zai-start-plan",modelId:"GLM-5.3-Flash"}`.
`model-selection.getView` returned `effectiveSelection:null`,
`selectionIssue:"provider-not-found"`, and no executable providers.
`usage-stats.getEntitlementSnapshot` returned `unavailableReason:"not_configured"`
with no balance. `zcode-agent.initialize` returned `available:false`,
`reasonCode:"provider_not_ready"`, and
`当前没有可用的模型供应商和模型，请先登录或配置 API Key。`.
`createSession` returned `project.remote-project-required`: this server requires
an explicit project owning the scratch directory. No prompt reached a model.

Further diagnosis through public RPC: `oauth.getActiveProvider` returned null,
`oauth.restoreCachedSession` returned null, the family selection settings were
empty, and all six account providers were non-executable. Startup logged
`project_token_invalid_response`. The shared credential file modification time
coincided with startup. Automatic OAuth invalidation is a possible explanation
(the server has that path); the log does not prove which response caused it.
No credentials were inspected. A fresh login is needed before retrying.
Runner PID 3120428 and server PID 3120439 were stopped and verified absent;
the original installed CLI checksum still matches.

## Backend driving contract (source inspection)

There is no REST session/prompt endpoint. `/api/server-info` is the readiness
check; `/ws` carries `@zcode/rpc` SocketProtocol binary framing (13-byte header)
and ChannelClient serialization. Service methods receive an array of arguments.
Loopback defaults to no server token. An explicitly configured token supports
Bearer authorization, a token query parameter, or the server's token cookie.
The Z.ai login is separate from this local transport authentication.

A backend needs the `project.saveProject`/session ownership step, model discovery
via `model-selection.getView`, and account setup through existing server settings
and OAuth services. Balance is exposed by `usage-stats.getEntitlementSnapshot`
with preferredProviderId, explicit Start Plan accountAccess and
invalidateBalanceCache. The server owns entitlement queries and X-Device-Mid.

The probe used legacy `zcode-agent.createSession`, `sendPrompt`, `readSession`,
`closeSession`, and `disposeWorkspace`; creation failed before sendPrompt.
For a maintained adapter, prefer v4: `helloConversationV4`,
`initializeConversationV4`, `sendConversationCommandV4` (createSession/sendText),
`subscribeConversationV4`, and `onDynamicConversationFrame`. Preserve clientId,
commandId, sessionId and replay cursor; distinguish command acknowledgment from
turn completion, handle permission requests, cancellation, reconnect and cleanup.

Provisional estimate: 2–4 engineer-days for a managed web-server RPC backend,
stream normalization, resume/abort and focused adapter tests; more if account
reconnection needs a UI. This branch has no `server/modules/providers/list/zcode/`
yet; the estimate uses the existing IProviderRuntime run/abort/inject contract.
Live inference, reported serving provider/model, balance delta and a final
feasibility verdict remain unverified until login is restored.
