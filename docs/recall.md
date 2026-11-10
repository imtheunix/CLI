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
