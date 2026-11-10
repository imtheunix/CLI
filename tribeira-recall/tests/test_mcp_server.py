from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tribeira_recall import mcp_server
from tribeira_recall.artifacts import ArtifactStore
from tribeira_recall.db import Document, Store
from tribeira_recall.memory_source import read_memories
from tribeira_recall.search import RecallSearch

from fakes import FakeEmbedder

FAKE_MEMORY_SERVER = r'''
import json
import os
import sys

log = os.environ["FAKE_MEMORY_LOG"]
for line in sys.stdin:
    message = json.loads(line)
    with open(log, "a") as output:
        output.write(json.dumps(message) + "\n")
    if "id" not in message:
        continue
    method = message["method"]
    if method == "initialize":
        result = {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "serverInfo": {"name": "fake-memory", "version": "0"},
        }
    elif method == "tools/call":
        result = {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "results": [
                                {
                                    "id": "m1",
                                    "memory": "Use focused tests for changed modules.",
                                    "scope": "reasoning:global",
                                    "kind": "decision",
                                },
                                {
                                    "id": "m2",
                                    "memory": "A trap: stale caches hide failures.",
                                    "scope": "opencode:demo",
                                    "kind": "lesson",
                                },
                            ]
                        }
                    ),
                }
            ]
        }
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
'''


class MemorySourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.script = self.root / "fake_memory.py"
        self.script.write_text(FAKE_MEMORY_SERVER)
        self.log = self.root / "calls.jsonl"

    def tearDown(self):
        self.temp.cleanup()

    def test_reads_only_memory_search_and_maps_documents(self):
        command = f"{sys.executable} {self.script}"
        with mock.patch.dict(
            os.environ,
            {
                "RECALL_MEMORY_MCP_COMMAND": command,
                "RECALL_MEMORY_SCOPES": "reasoning:global,opencode:demo",
                "FAKE_MEMORY_LOG": str(self.log),
            },
        ):
            documents = read_memories()
        self.assertEqual([doc.doc_key for doc in documents], ["memory:m1", "memory:m2"])
        self.assertEqual([doc.kind for doc in documents], ["decision", "lesson"])
        self.assertEqual(documents[0].source, "mem0:m1")
        self.assertEqual(documents[0].origin, "mem0")
        self.assertIn("focused tests", documents[0].content)
        self.assertEqual(len(documents[0].content_hash), 64)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual(
            [call["method"] for call in calls], ["initialize", "notifications/initialized", "tools/call"]
        )
        self.assertEqual(calls[2]["params"]["name"], "memory_search")
        self.assertEqual(calls[2]["params"]["arguments"]["scopes"], ["reasoning:global", "opencode:demo"])

    def test_unset_command_skips_source(self):
        with mock.patch.dict(os.environ, {"RECALL_MEMORY_MCP_COMMAND": ""}):
            self.assertEqual(read_memories(), [])


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


class McpToolInterfaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = Store(self.root / "recall.db")
        self.embedder = FakeEmbedder()
        documents = [
            Document(
                "a",
                "doc",
                "a.md",
                "hybrid ranking",
                "FTS5 BM25 cosine reciprocal rank fusion ranks documents",
                repo="alpha",
            ),
            Document(
                "s",
                "symbol",
                "mod.py:4",
                "recall",
                "def recall(query: str):",
                repo="alpha",
                signature="def recall(query: str):",
            ),
            Document("j", "job", "job:1", "worker timeout", "failed retry timeout from orchestrator worker"),
        ]
        self.store.put_documents(documents, self.embedder.embed([doc.content for doc in documents]))
        self.search = RecallSearch(self.store, self.embedder)
        self.artifacts = ArtifactStore(self.store, self.root / "artifacts", self.embedder)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def _call(self, name, *args, **kwargs):
        import tribeira_recall.mcp_server as server

        with mock.patch.object(server, "services", return_value=(self.store, self.search, self.artifacts)):
            return json.loads(getattr(server, name)(*args, **kwargs))

    def test_recall_symbol_and_similar_failures(self):
        recalled = self._call("recall", "hybrid rank", k=3)
        self.assertEqual(recalled["results"][0]["source"], "alpha:a.md")
        self.assertIn("BM25", recalled["results"][0]["why"])
        self.assertIn("snippet", recalled["results"][0])

        symbols = self._call("symbol", "recall", "alpha")
        self.assertEqual(symbols["symbols"][0]["source"], "alpha:mod.py:4")
        self.assertEqual(symbols["symbols"][0]["signature"], "def recall(query: str):")

        failures = self._call("similar_failures", "retry timeout")
        self.assertTrue(any(row["source"] == "job:1" for row in failures["failures"]))

    def test_artifact_tools_and_bounded_errors(self):
        created = self._call("artifact_put", "log", "worker log", content="line one\nline two", job="j1")
        self.assertTrue(created["id"].startswith("a_"))
        fetched = self._call("artifact_get", created["id"])
        self.assertEqual(fetched["content"], "line one\nline two")
        listed = self._call("artifact_list", "j1")
        self.assertEqual([row["id"] for row in listed["artifacts"]], [created["id"]])
        self.assertEqual(self._call("artifact_list", type="bogus")["error"], "unknown artifact type: bogus")
        self.assertIn("error", self._call("artifact_get", "missing"))
        self.assertIn("error", self._call("artifact_put", "log", "bad", content="api_key = abcdefghijklmnopqrstuvwxyz"))


if __name__ == "__main__":
    unittest.main()
