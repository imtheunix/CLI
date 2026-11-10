from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tribeira_recall.db import Document, Store
from tribeira_recall.formatting import bounded_json, clip_text
from tribeira_recall.search import RecallSearch, reciprocal_rank_fusion

from fakes import FakeEmbedder


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "recall.db")
        self.embedder = FakeEmbedder()
        docs = [
            Document("a", "doc", "a.md", "sqlite hybrid ranking", "FTS5 BM25 cosine reciprocal rank fusion ranks documents", repo="alpha"),
            Document("b", "job", "job:1", "worker timeout", "failed last_error retry timeout from orchestrator worker"),
            Document("c", "doc", "c.md", "gardening", "roses need water in summer", repo="beta"),
        ]
        self.store.put_documents(docs, self.embedder.embed([doc.content for doc in docs]))

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_rrf_combines_both_rankings(self):
        fused = reciprocal_rank_fusion([["a", "b"], ["b", "c"]])
        self.assertGreater(fused["b"], fused["a"])
        self.assertGreater(fused["b"], fused["c"])

    def test_hybrid_recall_filters_and_symbol(self):
        search = RecallSearch(self.store, self.embedder)
        rows = search.recall("hybrid rank", k=5)
        self.assertEqual(rows[0]["row"]["title"], "sqlite hybrid ranking")
        self.assertIn("BM25", rows[0]["why"])
        self.assertTrue(all(row["row"]["repo"] == "alpha" for row in search.recall("rank", repo="alpha")))
        failure = search.similar_failures("retry timeout")
        self.assertTrue(any("worker timeout" == row["row"]["title"] for row in failure))

    def test_symbol_location_and_response_cap(self):
        self.store.put_documents(
            [Document("s", "symbol", "mod.py:4", "recall", "def recall(query: str):", repo="alpha", signature="def recall(query: str):")],
            self.embedder.embed(["recall definition"]),
        )
        row = RecallSearch(self.store, self.embedder).symbol("recall", "alpha")[0]
        self.assertEqual(row["source"], "mod.py:4")
        self.assertEqual(row["signature"], "def recall(query: str):")
        huge = {"results": [{"snippet": "x" * 1200, "source": str(i), "why": "test"} for i in range(10)]}
        encoded = bounded_json(huge)
        self.assertLessEqual(len(__import__("json").dumps(encoded).encode()) + 256, 4000)
        self.assertLessEqual(len(clip_text("z" * 2000).encode()), 800)


if __name__ == "__main__":
    unittest.main()
