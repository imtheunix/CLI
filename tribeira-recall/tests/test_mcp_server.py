from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from tribeira_recall import mcp_server
from tribeira_recall.artifacts import ArtifactStore
from tribeira_recall.db import Document, Store
from tribeira_recall.search import RecallSearch

from fakes import FakeEmbedder


class McpToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = Store(self.root / "recall.db")
        self.embedder = FakeEmbedder()
        documents = [
            Document("a", "doc", "a.md", "sqlite hybrid ranking", "FTS5 BM25 cosine reciprocal rank fusion", repo="alpha"),
            Document("b", "job", "job:1", "worker timeout", "failed last_error retry timeout from worker"),
            Document(
                "s",
                "symbol",
                "mod.py:4",
                "recall",
                "def recall(query: str):",
                repo="alpha",
                signature="def recall(query: str):",
            ),
        ]
        self.store.put_documents(documents, self.embedder.embed([doc.content for doc in documents]))
        self.search = RecallSearch(self.store, self.embedder)
        self.artifacts = ArtifactStore(self.store, self.root / "artifacts", self.embedder)
        self.previous = (mcp_server._store, mcp_server._search, mcp_server._artifacts)
        mcp_server._store = self.store
        mcp_server._search = self.search
        mcp_server._artifacts = self.artifacts

    def tearDown(self):
        mcp_server._store, mcp_server._search, mcp_server._artifacts = self.previous
        self.store.close()
        self.temp.cleanup()

    def test_tool_surface_is_exposed(self):
        tools = asyncio.run(mcp_server.mcp.list_tools())
        names = {tool.name for tool in tools}
        self.assertEqual(
            names,
            {"recall", "symbol", "similar_failures", "artifact_put", "artifact_get", "artifact_list"},
        )

    def test_recall_and_symbol_tools_return_bounded_json(self):
        recalled = json.loads(mcp_server.recall("hybrid rank", k=3))
        self.assertTrue(recalled["results"])
        first = recalled["results"][0]
        self.assertEqual(first["source"], "alpha:a.md")
        self.assertEqual(first["kind"], "doc")
        self.assertIn("BM25", first["why"])
        self.assertIn("snippet", first)

        symbols = json.loads(mcp_server.symbol("recall", repo="alpha"))
        self.assertEqual(symbols["symbols"][0]["name"], "recall")
        self.assertEqual(symbols["symbols"][0]["source"], "alpha:mod.py:4")
        self.assertEqual(symbols["symbols"][0]["signature"], "def recall(query: str):")

    def test_similar_failures_tool(self):
        failures = json.loads(mcp_server.similar_failures("retry timeout"))
        self.assertTrue(any(row["source"] == "job:1" for row in failures["failures"]))

    def test_artifact_tools_round_trip_and_errors_are_bounded(self):
        created = json.loads(mcp_server.artifact_put("log", "worker log", content="line one\nline two"))
        fetched = json.loads(mcp_server.artifact_get(created["id"]))
        self.assertEqual(fetched["content"], "line one\nline two")
        listed = json.loads(mcp_server.artifact_list(type="log"))
        self.assertEqual(listed["artifacts"][0]["id"], created["id"])
        self.assertIn("error", json.loads(mcp_server.artifact_list(type="bogus")))
        self.assertIn("error", json.loads(mcp_server.artifact_get("missing")))


if __name__ == "__main__":
    unittest.main()
