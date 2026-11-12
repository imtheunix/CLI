# Recall MCP bounded verification (job 7ebc6f89)

Date: 2026-11-10
Branch: `feature/recall-mcp-verify-one-call-search-and-st-7ebc6f89`
Recovered source: checkpoint `38a07f26` plus the archived three-file WIP
`/tmp/opencode/b03db22c-final-wip.patch` (64 insertions / 5 deletions).

## Recovery

- Merged `38a07f26` with `--no-ff` as `1d47d6a4` (checkpoint preserved in history).
- Applied the archived WIP with `git apply --3way`; it applied cleanly to
  `docs/recall.md`, `tribeira-recall/evals/recall_bakeoff.py` and
  `tribeira-recall/src/tribeira_recall/mcp_server.py`.
- Committed the recovered WIP as `ba5b304e`.
- No other job worktree, stalled session, `tjob resume`, `/api/agent`, or new job was used.

## Changed files in this verification

- `tribeira-recall/src/tribeira_recall/memory_source.py` — close the child MCP
  stdin/stdout pipes in `finally` (removes ResourceWarnings; no behavior change).
- `tribeira-recall/tests/test_memory_source.py` — fake stdio memory MCP: unset
  command, result parsing/kind mapping, error propagation.
- `tribeira-recall/tests/test_embeddings.py` — `LocalEmbedder` with an injected
  fake model: empty input, dimension validation, query timing.
- `tribeira-recall/tests/test_cli.py` — `stats`, `cleanup`, `benchmark` (fake
  search), and `index`/`serve` dispatch, all on temp databases.
- `tribeira-recall/tests/test_mcp_server.py` — exposed tool surface and direct
  `recall`, `symbol`, `similar_failures`, `artifact_*` calls with injected fakes.
- `tribeira-recall/tests/test_mcp_stdio.py` — real subprocess stdio MCP exchange
  against a temp database.

## Focused test command and result

```sh
tribeira-recall/.venv/bin/python -m unittest discover -s tribeira-recall/tests -v
```

Result: **26 tests, 26 passed, 0 failed, 0 skipped** (about 1.3 s).

New test names:

- `test_memory_source.MemorySourceTests.test_unset_command_skips_source`
- `test_memory_source.MemorySourceTests.test_reads_search_results_without_write_tools`
- `test_memory_source.MemorySourceTests.test_error_response_is_raised`
- `test_embeddings.LocalEmbedderTests.test_empty_embed_does_not_load_model`
- `test_embeddings.LocalEmbedderTests.test_embed_and_query_validate_dimensions`
- `test_embeddings.LocalEmbedderTests.test_wrong_dimension_is_rejected`
- `test_cli.CliTests.test_stats_prints_counts`
- `test_cli.CliTests.test_cleanup_uses_temp_database`
- `test_cli.CliTests.test_benchmark_reports_latency_shape`
- `test_cli.CliTests.test_index_and_serve_dispatch`
- `test_mcp_server.McpToolTests.test_tool_surface_is_exposed`
- `test_mcp_server.McpToolTests.test_recall_and_symbol_tools_return_bounded_json`
- `test_mcp_server.McpToolTests.test_similar_failures_tool`
- `test_mcp_server.McpToolTests.test_artifact_tools_round_trip_and_errors_are_bounded`
- `test_mcp_stdio.McpStdioTests.test_real_stdio_exchange_recall_and_symbol`

## Real stdio smoke

Command (temp DB seeded with synthetic documents, real `python -m tribeira_recall serve`
subprocess over MCP stdio, `HF_HUB_OFFLINE=1`, `RECALL_ONNX_THREADS=1`):

```sh
tribeira-recall/.venv/bin/python /tmp/opencode/recall_stdio_smoke.py
```

Result (exit 0):

```text
tools: ['artifact_get', 'artifact_list', 'artifact_put', 'recall', 'similar_failures', 'symbol']
recall: alpha:a.md | BM25 #1 + cosine #1; RRF 0.0328
symbol: alpha:mod.py:4 | def recall(query: str):
```

The same exchange is covered by `test_mcp_stdio.McpStdioTests.test_real_stdio_exchange_recall_and_symbol`.

## Local dependency constraints

- Created `tribeira-recall/.venv` with `python3 -m venv` and installed the
  package editable (`pip install -e tribeira-recall`) per `docs/recall.md`.
- The stdio smoke uses the already-cached `all-MiniLM-L6-v2` ONNX model at
  `~/.cache/tribeira/fastembed` with `HF_HUB_OFFLINE=1`; no model download or
  provider call was made.
- All databases, artifact roots and fixtures are temporary directories. No
  production memory, production index, MCP config, service or network endpoint
  was read or changed.

## Explicitly unverified / remaining risks

- **No live-model evaluation.** This job did not re-run the bake-off and makes
  no claim about retrieval quality, latency, token savings or model choice.
  The earlier measurement report in `docs/recall.md` is inherited, not
  re-verified here.
- The stdio smoke uses synthetic documents and a fake embedder for indexing;
  the query embedding is the real local model. It proves the MCP transport and
  tool wiring, not semantic ranking quality.
- `MemorySource` is tested against a fake stdio MCP server, not the real
  `tribeira-memory` service.
- `LocalEmbedder` is tested with an injected fake model; the real ONNX path is
  only exercised indirectly by the stdio smoke.
- No whole-workspace/TSGE/CLI gate was run, by design.
