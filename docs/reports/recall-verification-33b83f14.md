# Recall MCP bounded verification (job 33b83f14)

Date: 2026-11-10
Branch: `feature/recall-mcp-verify-one-call-search-and-st-33b83f14`
Base: `origin/main` at `0d15dc39`

## Recovery

- Merged the original checkpoint `38a07f26` with `--no-ff` as `e4df1119` (`chore(recall): recover b03db22c checkpoint 38a07f26 for bounded verification`).
- Applied the archived three-file WIP delta `/tmp/opencode/b03db22c-final-wip.patch` with `git apply --3way`; it applied cleanly and was committed as `ca3071aa` (`chore(recall): apply b03db22c final WIP checkpoint for verification`).
- The original checkpoint remains in history. No other job worktree, stalled session, `tjob resume`, `/api/agent`, or new job was used.

## Changed files in this verification

Recovered feature files (from the checkpoint/WIP, not newly redesigned):

- `docs/recall.md`
- `tribeira-recall/evals/recall_bakeoff.py`
- `tribeira-recall/src/tribeira_recall/mcp_server.py`

Verification additions/fix:

- `tribeira-recall/src/tribeira_recall/memory_source.py` — close the fake/real MCP subprocess pipes in `finally` (removes `ResourceWarning`; no behavior change).
- `tribeira-recall/tests/test_mcp_server.py` — MCP tool surface with fakes, plus `MemorySource` against a synthetic stdio memory server.
- `tribeira-recall/tests/test_mcp_stdio.py` — real MCP stdio exchange against the actual `tribeira_recall serve` process, using a synthetic temp database and the cached local embedding model.
- `tribeira-recall/tests/test_embeddings.py` — `LocalEmbedder` with an injected fake model, including dimension validation.
- `tribeira-recall/tests/test_cli.py` — CLI `stats`, `cleanup`, `benchmark` (fake search), and `index`/`serve` dispatch.

## Environment and local dependencies

- Python 3.12.3.
- Created `tribeira-recall/.venv` and installed the package with `tribeira-recall/.venv/bin/python -m pip install -e tribeira-recall` (venv is git-ignored, not committed).
- Dependencies resolved from `pyproject.toml`: `mcp`, `fastembed`, `sqlite-vec`, `tree-sitter` and language grammars.
- The stdio test uses the already-cached local model at `~/.cache/tribeira/fastembed` (`sentence-transformers/all-MiniLM-L6-v2`). It is skipped with a clear reason if that cache is absent, so it never downloads a model or uses the network.
- All databases, artifacts, fake memory servers, and fixtures are created under `tempfile.TemporaryDirectory()`; no production memory, production DB, or production MCP configuration was read or changed.

## Focused test command and result

```sh
tribeira-recall/.venv/bin/python -m unittest discover -s tribeira-recall/tests -v
```

Result: **21 tests run, 21 passed, 0 failed, 0 skipped** (2.295 s).

Test names:

- `test_artifacts.ArtifactTests`: 5 passed
- `test_cli.CliTests`: 3 passed
- `test_embeddings.LocalEmbedderTests`: 2 passed
- `test_indexer.IndexerTests`: 3 passed
- `test_mcp_server.McpToolInterfaceTests`: 2 passed
- `test_mcp_server.MemorySourceTests`: 2 passed
- `test_mcp_stdio.McpStdioExchangeTests`: 1 passed
- `test_search.SearchTests`: 3 passed

## Real stdio smoke

The stdio smoke is `test_mcp_stdio.McpStdioExchangeTests.test_real_stdio_recall_and_symbol`. It spawns the real server with:

```sh
tribeira-recall/.venv/bin/python -m tribeira_recall serve
```

with `RECALL_DB` and `RECALL_ARTIFACT_ROOT` pointing at a temp directory, then performs a real MCP `initialize`, `tools/list`, `recall`, and `symbol` exchange over stdio.

Observed result: `ok`. The server advertised `recall`, `symbol`, `similar_failures`, `artifact_put`, `artifact_get`, and `artifact_list`; `recall` returned the synthetic `alpha:a.md` document with BM25 evidence, and `symbol` returned `alpha:mod.py:4` with signature `def recall(query: str):`.

## Explicitly unverified / remaining risks

- No live-model or provider evaluation was run. This report makes no claim about real retrieval quality, latency, model choice, or bake-off pass rates.
- The stdio exchange uses a synthetic temp database and the cached local embedding model; it does not prove behavior against the production index or production memory.
- `MemorySource` is tested against a synthetic stdio MCP server, not the real Mem0 service.
- The CLI benchmark test injects a fake search object; it does not measure real query latency.
- No whole TSGE/CLI workspace gate, service restart, deployment, production MCP config change, memory indexing, or outbound push was performed.
- The prior bake-off result in `docs/recall.md` remains the original job's measurement, not re-verified here.
