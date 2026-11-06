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

Live inference and integration findings are pending the probe.
