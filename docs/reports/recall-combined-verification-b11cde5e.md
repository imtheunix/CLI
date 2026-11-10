# Recall MCP combined verification after two merged candidates (job 1af376cb)

Date: 2026-11-10
Worktree: `/home/busu/Tribeira/.jobs/tribeiracli/1af376cb`, branch
`bugfix/recall-mcp-verify-both-merged-test-sets--1af376cb`, made from `origin/main`.
Target: `b11cde5e` (job 33b83f14), earlier candidate `c2dd5114` (job 7ebc6f89).
Both confirmed as ancestors of this branch's HEAD; no old job worktree or branch was read.

**Verdict: PASS.**

## Merge delta between the two candidates

```sh
git diff --stat c2dd5114..b11cde5e
git diff c2dd5114..b11cde5e -- tribeira-recall/src   # empty (0 bytes)
```

Only five files differ: the second report plus the four test files
(`test_cli.py`, `test_embeddings.py`, `test_mcp_server.py`, `test_mcp_stdio.py`).
The `tribeira-recall/src` delta is exactly empty, so the two candidates verified
byte-identical production code.

## Overlap inspection (what the rebased merge did to the tests)

- **No erased assertions.** Every `-` line in the c2dd5114 → b11cde5e diff is a
  refactor, not a removed check: per-test seeding moved to `setUp`, `names` was
  renamed `tools`, the `environment` dict became `env = dict(os.environ)` plus
  `update`. All original assertions survive, several were strengthened
  (six-tool superset check, `BM25` in `why`, symbol signature equality).
- **No accidental duplicate names.** Scanned all 8 test modules for duplicate
  class or `test_` method names: none. The near-twin pairs are distinct on
  purpose (`McpStdioTests` vs `McpStdioExchangeTests`, `McpToolTests` vs
  `McpToolInterfaceTests`); `MemorySourceTests` exists in two different modules
  (`test_memory_source.py`, `test_mcp_server.py`), which unittest keeps separate.
- **No fixture/temp-env collisions.** Every class uses its own
  `tempfile.TemporaryDirectory()` with cleanup; env mutations are scoped by
  `mock.patch.dict` context managers; the stdio classes pass the child an
  explicit env copy (`RECALL_DB`, `RECALL_ARTIFACT_ROOT`, `FASTEMBED_CACHE_PATH`,
  `RECALL_ONNX_THREADS=1`, `HF_HUB_OFFLINE=1`) with `cwd` pinned to
  `tribeira-recall/` — no host config leakage.
- **No silent stdio skips.** The only skip in the combined tree is the explicit
  `@unittest.skipUnless(MODEL_CACHE.is_dir(), ...)` on `McpStdioExchangeTests`;
  `McpStdioTests` is undecorated and always performs the real subprocess
  exchange. Both ran for real here (server-side `ListToolsRequest` /
  `CallToolRequest` logs visible in the verbose run).

## Combined-tree test run (this worktree, fresh venv per docs/recall.md)

```sh
python3 -m venv tribeira-recall/.venv && tribeira-recall/.venv/bin/python -m pip install -e tribeira-recall
tribeira-recall/.venv/bin/python -m unittest discover -s tribeira-recall/tests -v
```

Result: **Ran 35 tests in 2.879s — 35 passed, 0 failed, 0 skipped.**

The count reconciles exactly with the two producer reports: 11 pre-existing
tests + all 15 names claimed by `c2dd5114:docs/reports/recall-verification-7ebc6f89.md`
+ 9 names from the 33b83f14 candidate = 35. No test was lost to a name
collision, and neither pre-merge 26/26 nor 21/21 is being used as evidence —
this 35/35 is a real run of the combined tree.

Key combined-surface classes in the run:

- `test_mcp_server.McpToolTests` (4) — candidate 1's direct tool calls with fakes.
- `test_mcp_server.McpToolInterfaceTests` (2) — candidate 2's store-backed tool calls.
- `test_mcp_server.MemorySourceTests` (2) + `test_memory_source.MemorySourceTests` (3) — both memory-source suites survive.
- `test_mcp_stdio.McpStdioTests` (1) and `test_mcp_stdio.McpStdioExchangeTests` (1) — both real stdio exchanges ran, none skipped.
- `test_cli.CliTests` (6), `test_embeddings.LocalEmbedderTests` (5), plus the untouched
  `test_artifacts` (5), `test_indexer` (3), `test_search` (3).

## Independent real stdio probe (my own, stricter than the producers')

A scratch script (kept out of the repo, `/tmp/recall-probe-1af376cb/probe.py`)
seeded a temp database **with the real cached local embedder** (offline:
`HF_HUB_OFFLINE=1`, cached `all-MiniLM-L6-v2` ONNX, `RECALL_ONNX_THREADS=1`),
spawned the checked-in `python -m tribeira_recall serve` as a subprocess, and
exercised the full MCP surface over stdio:

- `initialize` → protocol `2025-11-25`, server `tribeira-recall`
- `tools/list` → exactly `recall`, `symbol`, `similar_failures`, `artifact_put`, `artifact_get`, `artifact_list`
- `recall(query="hybrid ranking")` → top hit `alpha:a.md`, `why=BM25 #1 + cosine #1; RRF 0.0328`
- `symbol(name="recall", repo="alpha")` → `alpha:mod.py:4`, signature `def recall(query: str):`
- `similar_failures(text=...)` → hit synthetic `job:9`
- `artifact_put` → `artifact_get` → `artifact_list` round trip bound to one job id
- After the client contexts closed, `pgrep` found **no leftover `tribeira_recall` processes** — child cleanup confirmed.

All 9 checks passed (exit 0). Three initial failures were bugs in my probe's
kwarg names (`title`→`summary`, `query`→`text`, `artifact_id`→`id`), fixed in
the probe only; product code and existing tests were never modified.

## Boundaries respected

No production memory/DB access, no global config changes, no provider/model
network calls (all embeddings from the local cached ONNX model, offline), no
service restarts, no new jobs, no workspace gate, no pushes. Everything ran in
this worktree's temp dirs and venv; the probe subprocess exited cleanly.

## Remaining gaps (unchanged from the producers' own caveats)

- No semantic-quality, latency, or token-savings claim is made; the bake-off
  numbers in `docs/recall.md` stay inherited, not re-verified.
- `MemorySource` is covered only against synthetic stdio MCP servers, not the
  real Mem0 service.
- If the fastembed cache were absent, `McpStdioExchangeTests` would skip
  (loudly, with reason) and `McpStdioTests` would fall back to `FakeEmbedder`
  indexing (384-dim, so dimensions stay coherent). That fallback path was not
  exercised here because the cache exists on this machine.
