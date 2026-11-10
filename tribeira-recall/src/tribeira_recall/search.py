from __future__ import annotations

import re
import sqlite3
from collections import defaultdict
from typing import Sequence

import sqlite_vec

from .embeddings import Embedder, LocalEmbedder
from .db import Store

RRF_K = 60


def reciprocal_rank_fusion(rankings: Sequence[Sequence[str]], k: int = RRF_K) -> dict[str, float]:
    scores: dict[str, float] = defaultdict(float)
    for ranking in rankings:
        for rank, item_id in enumerate(ranking, 1):
            scores[item_id] += 1.0 / (k + rank)
    return scores


class RecallSearch:
    def __init__(self, store: Store, embedder: Embedder | None = None):
        self.store = store
        self.embedder = embedder or LocalEmbedder()

    def recall(self, query: str, kinds: Sequence[str] | None = None, repo: str | None = None, k: int = 5) -> list[dict]:
        k = max(1, min(int(k), 20))
        filters, params = _filters(kinds, repo)
        keyword: list[int] = []
        match = fts_query(query)
        if match:
            try:
                rows = self.store.db.execute(
                    f"""SELECT d.id, bm25(documents_fts) AS rank FROM documents_fts
                        JOIN documents d ON d.id=documents_fts.rowid
                        WHERE documents_fts MATCH ? {filters} ORDER BY rank LIMIT 80""",
                    [match, *params],
                ).fetchall()
                keyword = [row["id"] for row in rows]
            except sqlite3.OperationalError:
                keyword = []
        vector: list[int] = []
        query_embedding = self.embedder.query(query)
        vector_filter, vector_params = _vector_filters(kinds, repo)
        rows = self.store.db.execute(
            f"""SELECT rowid, distance FROM document_vectors
                WHERE embedding MATCH ? AND k=80 {vector_filter} ORDER BY distance""",
            (sqlite_vec.serialize_float32(query_embedding), *vector_params),
        ).fetchall()
        vector = [row["rowid"] for row in rows]
        scores = reciprocal_rank_fusion([[str(i) for i in keyword], [str(i) for i in vector]])
        ids = sorted((int(value) for value in scores), key=lambda item: -scores[str(item)])
        results = []
        keyword_ranks = {doc_id: rank for rank, doc_id in enumerate(keyword, 1)}
        vector_ranks = {doc_id: rank for rank, doc_id in enumerate(vector, 1)}
        for doc_id in ids[:k]:
            row = self.store.db.execute("SELECT * FROM documents WHERE id=?", (int(doc_id),)).fetchone()
            if not row:
                continue
            evidence = []
            if doc_id in keyword_ranks:
                evidence.append(f"BM25 #{keyword_ranks[doc_id]}")
            if doc_id in vector_ranks:
                evidence.append(f"cosine #{vector_ranks[doc_id]}")
            results.append(dict(row=row, score=scores[str(doc_id)], why=" + ".join(evidence)))
        return results

    def symbol(self, name: str, repo: str | None = None) -> list[sqlite3.Row]:
        params: list[object] = [name]
        repo_filter = ""
        if repo:
            repo_filter = "AND repo=?"
            params.append(repo)
        rows = self.store.db.execute(
            f"""SELECT * FROM documents WHERE kind IN ('symbol','export') AND title=? {repo_filter}
                ORDER BY length(source), source LIMIT 20""",
            params,
        ).fetchall()
        if rows:
            return rows
        like_params: list[object] = [f"%{name}%", *([repo] if repo else [])]
        return self.store.db.execute(
            f"""SELECT * FROM documents WHERE kind IN ('symbol','export') AND title LIKE ? {repo_filter}
                ORDER BY CASE WHEN title LIKE ? THEN 0 ELSE 1 END, length(title), source LIMIT 20""",
            [*like_params, f"{name}%"],
        ).fetchall()

    def similar_failures(self, text: str) -> list[dict]:
        return self.recall(f"{text} failed failure refute error", kinds=["job", "lesson", "experiment"], k=5)


def _filters(kinds: Sequence[str] | None, repo: str | None) -> tuple[str, list[str]]:
    sql = ""
    params: list[str] = []
    if kinds:
        sql += f" AND d.kind IN ({','.join('?' for _ in kinds)})"
        params.extend(kinds)
    if repo:
        sql += " AND d.repo=?"
        params.append(repo)
    return sql, params


def _vector_filters(kinds: Sequence[str] | None, repo: str | None) -> tuple[str, list[str]]:
    sql = ""
    params: list[str] = []
    if kinds:
        sql += f" AND kind IN ({','.join('?' for _ in kinds)})"
        params.extend(kinds)
    if repo:
        sql += " AND repo=?"
        params.append(repo)
    return sql, params


def fts_query(query: str) -> str:
    words = re.findall(r"[\w.-]+", query, flags=re.UNICODE)[:16]
    return " OR ".join('"' + word.replace('"', '""') + '"' for word in words)
