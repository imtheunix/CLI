# tribeira-recall

`tribeira-recall` is a repo-local Python package in `tribeira-recall/`. It is a stdio MCP server, not a daemon. A single SQLite database (`~/.local/share/tribeira/recall.db` by default) holds FTS5 keyword search, sqlite-vec cosine search, and artifact metadata. Reciprocal rank fusion combines BM25 and vector ranks (`k=60`). `all-MiniLM-L6-v2` runs locally through fastembed/ONNX on CPU; inference makes no API calls. The first run downloads the model into `FASTEMBED_CACHE_PATH`.

## Setup

From the repository root:

```sh
python3 -m venv tribeira-recall/.venv
tribeira-recall/.venv/bin/python -m pip install -e tribeira-recall
export FASTEMBED_CACHE_PATH="$PWD/tribeira-recall/.cache/fastembed" # optional local-development cache
tribeira-recall/.venv/bin/python -m tribeira_recall index --root ~/Tribeira
tribeira-recall/.venv/bin/python -m tribeira_recall benchmark --repetitions 50
```

The default model cache is `~/.cache/tribeira/fastembed`; no cache directory needs to be exported for normal installation. `RECALL_DB`, `RECALL_ARTIFACT_ROOT`, `RECALL_ONNX_THREADS`, and `RECALL_OWNER` override the other defaults.

## OpenCode MCP wiring

Add this snippet to an **OpenCode project configuration of your choice**. The job did not modify `~/.config/opencode/opencode.jsonc`.

```jsonc
{
  "mcp": {
    "tribeira-recall": {
      "type": "local",
      "command": [
        "/home/busu/Tribeira/tribeiracli/tribeira-recall/.venv/bin/python",
        "-m",
        "tribeira_recall",
        "serve"
      ],
      "enabled": true,
      "environment": {
        "RECALL_OWNER": "opencode",
        "FASTEMBED_CACHE_PATH": "/home/busu/.cache/tribeira/fastembed",
        "RECALL_ONNX_THREADS": "4"
      }
    }
  }
}
```

Tools:

- `recall(query, kinds?, repo?, k=5)` returns at most `k` snippets, each at most 200 tokens, with source and BM25/cosine evidence.
- `symbol(name, repo?)` returns definition locations and signatures.
- `similar_failures(text)` searches job errors, refutes, lessons, and experiment rows.
- `artifact_put(type, summary, content|path, job?, session?)` returns a write-once ID; content matching common private-key/token patterns is refused.
- `artifact_get(id, start_line?, end_line?)` defaults to 200 lines. `artifact_list(job?, type?, limit=20)` returns references, not content.
- Every tool response is capped at approximately 1,000 tokens, including JSON escaping allowance.

Artifacts live under `~/.local/share/tribeira/artifacts/<job-or-session>/<id>`. They are UTF-8 oriented, at most 50 MB, checksummed with SHA-256, indexed for recall, and expired by:

```sh
tribeira-recall/.venv/bin/python -m tribeira_recall cleanup --days 30
```

Do not store secrets even though the common-pattern filter exists.

MCP server instructions are not necessarily added to the model's context. Add this line to the OpenCode project's instructions when you want agents to prefer the retrieval workflow:

> If `tribeira-recall` is available, start unfamiliar-code exploration with one `recall` call (or `symbol` when the exact symbol is known), before `find`/`grep` or broad file reads. Use the returned locations for focused reads; do not repeat searches that did not help.

## Indexed sources and incremental behavior

- Every repository below `~/Tribeira` with `.git`: TypeScript/TSX, Python, and Rust declarations (tree-sitter), `docs/**`, and all `AGENTS.md` files.
- Global `~/Tribeira/docs/**`.
- Read-only `~/.cloudcli/auth.db`, selected `orchestrator_jobs` fields.
- `~/.local/share/tribeira/experiments/*/results.jsonl`.
- Optional read-only tribeira-memory MCP. Set `RECALL_MEMORY_MCP_COMMAND` to its stdio command and `RECALL_MEMORY_SCOPES` (defaults include `reasoning:*` and the three global agent-note scopes). The indexer calls only `memory_search`, never a memory write. If unset, this source is skipped.

SHA-256 file and document hashes skip unchanged work. Changed files replace their old rows atomically per batch; deleted source files and jobs are removed. The indexer uses a nonblocking lock to prevent overlapping timer runs.

Files `tribeira-recall/systemd/tribeira-recall-index.service` and `.timer` provide every-10-minutes indexing. `tribeira-recall-cleanup.service` and `.timer` independently apply the 30-day retention policy daily. They are examples only; this job did not install or enable them, start any service, or restart CloudCLI.

## Focused tests and replay

```sh
tribeira-recall/.venv/bin/python -m unittest discover -s tribeira-recall/tests -v
tribeira-recall/.venv/bin/python tribeira-recall/evals/recall_bakeoff.py
```

The bake-off is copied/adapted from `~/.cache/ab/bake2.py`; the original is untouched. It runs DeepSeek 1017 on `d6a7b815`, `20450fe0`, and `a018c56e`, three repetitions per arm. Every “with MCP” run receives a fresh database built solely from that replay's base revision (no jobs, Mem0, experiments, or global docs), preventing future-code and cross-repetition leakage. Raw logs, ledgers, results, and summary are in `/tmp/tribeira-recall-mcp-ab/`. `RECALL_BAKE_WORKERS` controls concurrency (default 3).

Keep the MCP only if hidden-test pass rate holds and model calls or uncached input falls. Calls are completed upstream model requests (including title/compaction/subagents), not a claim about human conversational turns.

## Measurement report (2026-11-10)

The focused suite passes 11/11 tests. The real index covers 151 repositories and 27,479 files: 222,350 documents (189,416 symbols, 25,302 documentation chunks, 7,006 exports, 537 jobs, and 89 experiment rows). The full index took 7,604.71 s; an immediate incremental re-index with every file unchanged took 2.57 s wall time (2,450.66 ms inside the indexer). In the idle 50-query benchmark, query p50 was 204.61 ms, p95 was 308.62 ms, maximum was 312.48 ms, and embedding p95 was 2.38 ms. **The 50 ms query-p95 criterion failed**; sqlite-vec scanning, not local embedding, dominates latency.

The final bake used DeepSeek 1017, three jobs and three repetitions per arm, run signature `52c4bc2a62d1dd6cfe7672a84057c267629f3a83c2078a3e190c6f54cd745d37`. Both arms received the same conditional usage instruction quoted above. The harness reads OpenCode tool-part rows to count actual recall calls; all nine with-MCP runs used recall once. An earlier exposure-only attempt was discarded because none of its with-MCP runs called a recall tool.

| Arm | Hidden-test pass rate | Mean model calls | Mean uncached input | Mean wall time | Runs using recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| Without MCP | 9/9 (100%) | 28.56 | 56,240.44 | 254.44 s | 0/9 |
| With MCP | 8/9 (88.89%) | 27.89 | 62,533.56 | 248.11 s | 9/9 |

With MCP, calls fell 2.3% and mean wall time fell 2.5%, but uncached input rose 11.2% and pass rate fell. **The keep criterion failed.** The failing `a018c56e` repetition passed 17/18 hidden tests and made no commit; its transcript ends at an external-directory permission refusal. The original `~/.cache/ab/bake2.py` remains unchanged (SHA-256 `044e4e29f7475bca8dc289bbe307f86f2e84876ebcf3cee90bcef235c4f3cdf6`). Raw results are in `/tmp/tribeira-recall-mcp-ab/`.

No OpenCode user configuration was changed and no systemd unit was installed or enabled. The implementation remains on its experimental branch for the person's retain/discard decision; it was not marked done.
