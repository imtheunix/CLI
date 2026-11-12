from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from tribeira_recall.db import Document, Store
from tribeira_recall.embeddings import LocalEmbedder

from fakes import FakeEmbedder

MODEL_CACHE = Path(os.environ.get("FASTEMBED_CACHE_PATH", "~/.cache/tribeira/fastembed")).expanduser()


class _BaseMcpStdio(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / "recall.db"
        if MODEL_CACHE.is_dir():
            embedder = LocalEmbedder()
        else:
            embedder = FakeEmbedder()
        documents = [
            Document(
                "a",
                "doc",
                "a.md",
                "sqlite hybrid ranking",
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
        ]
        with Store(self.db) as store:
            store.put_documents(documents, embedder.embed([doc.content for doc in documents]))

    def tearDown(self):
        self.temp.cleanup()

    def _run_stdio_exchange(self, query: str = "hybrid ranking"):
        env = dict(os.environ)
        env.update(
            {
                "RECALL_DB": str(self.db),
                "RECALL_ARTIFACT_ROOT": str(self.root / "artifacts"),
                "FASTEMBED_CACHE_PATH": str(MODEL_CACHE),
                "RECALL_ONNX_THREADS": "1",
                "HF_HUB_OFFLINE": "1",
            }
        )
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "tribeira_recall", "serve"],
            env=env,
            cwd=str(Path(__file__).resolve().parents[1]),
        )

        async def exchange():
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools_result = await session.list_tools()
                    tools = {tool.name for tool in tools_result.tools}
                    recalled = await session.call_tool("recall", {"query": query, "k": 3})
                    symbols = await session.call_tool("symbol", {"name": "recall", "repo": "alpha"})
                    return tools, recalled, symbols

        tools, recalled, symbols = asyncio.run(exchange())
        self.assertIn("recall", tools)
        self.assertIn("symbol", tools)
        self.assertTrue({"recall", "symbol", "similar_failures", "artifact_put", "artifact_get", "artifact_list"} <= tools)
        self.assertFalse(recalled.isError)
        recalled_payload = json.loads(recalled.content[0].text)
        self.assertTrue(recalled_payload["results"])
        self.assertEqual(recalled_payload["results"][0]["source"], "alpha:a.md")
        self.assertIn("BM25", recalled_payload["results"][0]["why"])
        self.assertFalse(symbols.isError)
        symbol_payload = json.loads(symbols.content[0].text)
        self.assertEqual(symbol_payload["symbols"][0]["name"], "recall")
        self.assertEqual(symbol_payload["symbols"][0]["source"], "alpha:mod.py:4")
        self.assertEqual(symbol_payload["symbols"][0]["signature"], "def recall(query: str):")


class McpStdioTests(_BaseMcpStdio):
    def test_real_stdio_exchange_recall_and_symbol(self):
        self._run_stdio_exchange("hybrid ranking")


@unittest.skipUnless(MODEL_CACHE.is_dir(), "local fastembed model cache is not available")
class McpStdioExchangeTests(_BaseMcpStdio):
    def test_real_stdio_recall_and_symbol(self):
        self._run_stdio_exchange("hybrid rank")


if __name__ == "__main__":
    unittest.main()
