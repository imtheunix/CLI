from __future__ import annotations

import functools
import threading
from typing import Literal

from mcp.server.fastmcp import FastMCP

from .artifacts import ARTIFACT_TYPES, ArtifactStore
from .config import database_path
from .db import Store
from .embeddings import LocalEmbedder
from .formatting import bounded_json, clip_text
from .search import RecallSearch

mcp = FastMCP(
    "tribeira-recall",
    instructions=(
        "Search local code/docs/jobs/decisions/experiments and artifacts in one call. "
        "When exploring unfamiliar code, start with one targeted recall call instead of shell searches; "
        "then read only the selected source files for exact context. "
        "Use artifact references for large delegation outputs instead of pasting content."
    ),
)
_store: Store | None = None
_search: RecallSearch | None = None
_artifacts: ArtifactStore | None = None
_lock = threading.RLock()


def services() -> tuple[Store, RecallSearch, ArtifactStore]:
    global _store, _search, _artifacts
    if _store is None:
        embedder = LocalEmbedder()
        _store = Store(database_path())
        _search = RecallSearch(_store, embedder)
        _artifacts = ArtifactStore(_store, embedder=embedder)
    return _store, _search, _artifacts  # type: ignore[return-value]


def bounded_errors(function):
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except Exception as error:
            return bounded_json({"error": f"{type(error).__name__}: {str(error)[:240]}"})

    return wrapped


def _result_rows(results: list[dict]) -> list[dict]:
    rows = []
    for result in results:
        row = result["row"]
        rows.append(
            {
                "source": f"{row['repo'] + ':' if row['repo'] else ''}{row['source']}",
                "kind": row["kind"],
                "snippet": clip_text(row["content"]),
                "why": f"{result['why']}; RRF {result['score']:.4f}",
            }
        )
    return rows


@mcp.tool()
@bounded_errors
def recall(query: str, kinds: list[str] | None = None, repo: str | None = None, k: int = 5) -> str:
    """Locate relevant local code, docs, jobs or lessons in one hybrid BM25+cosine call.

    When the path is unknown, use this once before find/grep or broad file reads. Ask for the
    function, error or task by name; optionally restrict kinds/repo. Returns <=k short snippets
    with source locations and evidence. Read only the selected files afterward for full context.
    """
    with _lock:
        _, search, _ = services()
        results = search.recall(query, kinds, repo, k)
    return bounded_json({"results": _result_rows(results)})


@mcp.tool()
@bounded_errors
def symbol(name: str, repo: str | None = None) -> str:
    """Resolve a known function/class/export name to its definition location and signature.

    Prefer this to grep when you already know the symbol name; then read the identified file only
    if implementation details are needed.
    """
    with _lock:
        _, search, _ = services()
        rows = search.symbol(name, repo)
    return bounded_json(
        {
            "symbols": [
                {
                    "name": row["title"],
                    "source": f"{row['repo'] + ':' if row['repo'] else ''}{row['source']}",
                    "signature": clip_text(row["signature"] or "", 200),
                    "doc": clip_text(row["content"], 100),
                }
                for row in rows
            ]
        }
    )


@mcp.tool()
@bounded_errors
def similar_failures(text: str) -> str:
    """Find past jobs, refutes, lessons and experiments matching a failure; returns <=5 small snippets."""
    with _lock:
        _, search, _ = services()
        results = search.similar_failures(text)
    return bounded_json({"failures": _result_rows(results)})


@mcp.tool()
@bounded_errors
def artifact_put(
    type: Literal["log", "test", "report", "verdict", "patch", "plan", "json", "other"],
    summary: str,
    content: str | None = None,
    path: str | None = None,
    job: str | None = None,
    session: str | None = None,
) -> str:
    """Write once (content OR path), refuse secrets, index for recall, return a lightweight artifact id."""
    with _lock:
        _, _, artifacts = services()
        result = artifacts.put(type, summary, content=content, path=path, job=job, session=session)
    return bounded_json(result)


@mcp.tool()
@bounded_errors
def artifact_get(id: str, start_line: int = 1, end_line: int | None = None) -> str:
    """Read an artifact by id; defaults to lines 1-200 and enforces the 1k-token response cap."""
    with _lock:
        _, _, artifacts = services()
        result = artifacts.get(id, start_line, end_line)
    return bounded_json(result)


@mcp.tool()
@bounded_errors
def artifact_list(job: str | None = None, type: str | None = None, limit: int = 20) -> str:
    """List newest artifact references, optionally filtered by job and type; never returns full content."""
    if type is not None and type not in ARTIFACT_TYPES:
        return bounded_json({"error": f"unknown artifact type: {type}"})
    with _lock:
        _, _, artifacts = services()
        rows = artifacts.list(job, type, limit)
    return bounded_json({"artifacts": rows})


def run() -> None:
    mcp.run(transport="stdio")
