from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

from .artifacts import ArtifactStore
from .config import database_path
from .db import Store
from .indexer import main as index_main
from .search import RecallSearch

BENCHMARK_QUERIES = [
    "orchestrator job retry failure",
    "OpenCode session message tokens",
    "artifact retention and secret refusal",
    "hybrid reciprocal rank fusion",
    "function definitions and incremental indexing",
]


def benchmark(db: Path, repetitions: int = 20) -> dict:
    with Store(db) as store:
        search = RecallSearch(store)
        measurements = []
        embedding_ms = []
        search.recall("warm up embedding and SQLite", k=1)
        for index in range(repetitions):
            query = BENCHMARK_QUERIES[index % len(BENCHMARK_QUERIES)]
            started = time.perf_counter()
            search.recall(query, k=5)
            elapsed = (time.perf_counter() - started) * 1000
            measurements.append(elapsed)
            embedding_ms.append(search.embedder.last_query_ms)  # type: ignore[attr-defined]
        return {
            "documents": store.counts()["documents"],
            "repetitions": repetitions,
            "query_p50_ms": round(statistics.median(measurements), 3),
            "query_p95_ms": round(_percentile(measurements, 0.95), 3),
            "query_max_ms": round(max(measurements), 3),
            "embedding_p95_ms": round(_percentile(embedding_ms, 0.95), 3),
        }


def _percentile(values: list[float], percentile: float) -> float:
    values = sorted(values)
    position = min(len(values) - 1, round((len(values) - 1) * percentile))
    return values[position]


def cleanup(db: Path, days: int = 30) -> dict:
    from .embeddings import LocalEmbedder

    with Store(db) as store:
        # Cleanup never initializes the embedding model.
        artifacts = ArtifactStore(store, embedder=LocalEmbedder())
        return artifacts.cleanup(days)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "index":
        return index_main(argv[1:])
    parser = argparse.ArgumentParser(prog="tribeira-recall")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("index", help="incrementally index local sources")
    serve_parser = subparsers.add_parser("serve", help="run the stdio MCP server")
    serve_parser.set_defaults(command="serve")
    bench_parser = subparsers.add_parser("benchmark", help="measure real-index query latency")
    bench_parser.add_argument("--db", type=Path, default=database_path())
    bench_parser.add_argument("--repetitions", type=int, default=20)
    clean_parser = subparsers.add_parser("cleanup", help="delete artifacts older than 30 days")
    clean_parser.add_argument("--db", type=Path, default=database_path())
    clean_parser.add_argument("--days", type=int, default=30)
    stats_parser = subparsers.add_parser("stats", help="print index counts")
    stats_parser.add_argument("--db", type=Path, default=database_path())
    args = parser.parse_args(argv)
    if args.command == "serve":
        from .mcp_server import run

        run()
        return 0
    if args.command == "benchmark":
        print(json.dumps(benchmark(args.db, args.repetitions), indent=2))
        return 0
    if args.command == "cleanup":
        print(json.dumps(cleanup(args.db, args.days), separators=(",", ":")))
        return 0
    if args.command == "stats":
        with Store(args.db) as store:
            print(json.dumps(store.counts(), separators=(",", ":")))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
