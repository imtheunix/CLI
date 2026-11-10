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

from fakes import FakeEmbedder


class McpStdioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / "recall.db"
        embedder = FakeEmbedder()
        documents = [
            Document("a", "doc", "a.md", "sqlite hybrid ranking", "FTS5 BM25 cosine reciprocal rank fusion", repo="alpha"),
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

    def test_real_stdio_exchange_recall_and_symbol(self):
        environment = {
            **os.environ,
            "RECALL_DB": str(self.db),
            "RECALL_ARTIFACT_ROOT": str(self.root / "artifacts"),
            "RECALL_ONNX_THREADS": "1",
            "HF_HUB_OFFLINE": "1",
        }
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "tribeira_recall", "serve"],
            env=environment,
        )

        async def exchange():
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    names = {tool.name for tool in tools.tools}
                    recalled = await session.call_tool("recall", {"query": "hybrid ranking", "k": 3})
                    symbols = await session.call_tool("symbol", {"name": "recall", "repo": "alpha"})
                    return names, recalled, symbols

        names, recalled, symbols = asyncio.run(exchange())
        self.assertIn("recall", names)
        self.assertIn("symbol", names)
        self.assertFalse(recalled.isError)
        recalled_payload = json.loads(recalled.content[0].text)
        self.assertTrue(recalled_payload["results"])
        self.assertEqual(recalled_payload["results"][0]["source"], "alpha:a.md")
        self.assertFalse(symbols.isError)
        symbol_payload = json.loads(symbols.content[0].text)
        self.assertEqual(symbol_payload["symbols"][0]["name"], "recall")
        self.assertEqual(symbol_payload["symbols"][0]["source"], "alpha:mod.py:4")


if __name__ == "__main__":
    unittest.main()
