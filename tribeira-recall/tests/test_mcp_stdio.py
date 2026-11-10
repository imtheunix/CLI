from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from tribeira_recall.db import Document, Store
from tribeira_recall.embeddings import LocalEmbedder

MODEL_CACHE = Path(os.environ.get("FASTEMBED_CACHE_PATH", "~/.cache/tribeira/fastembed")).expanduser()


@unittest.skipUnless(MODEL_CACHE.is_dir(), "local fastembed model cache is not available")
class McpStdioExchangeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / "recall.db"
        embedder = LocalEmbedder()
        with Store(self.db) as store:
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
            ]
            store.put_documents(documents, embedder.embed([doc.content for doc in documents]))

    def tearDown(self):
        self.temp.cleanup()

    def test_real_stdio_recall_and_symbol(self):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        env = dict(os.environ)
        env.update(
            {
                "RECALL_DB": str(self.db),
                "RECALL_ARTIFACT_ROOT": str(self.root / "artifacts"),
                "FASTEMBED_CACHE_PATH": str(MODEL_CACHE),
                "RECALL_ONNX_THREADS": "1",
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
                    tools = {tool.name for tool in (await session.list_tools()).tools}
                    recalled = await session.call_tool("recall", {"query": "hybrid rank", "k": 3})
                    symbols = await session.call_tool("symbol", {"name": "recall", "repo": "alpha"})
                    return tools, recalled, symbols

        tools, recalled, symbols = asyncio.run(exchange())
        self.assertTrue({"recall", "symbol", "similar_failures", "artifact_put", "artifact_get", "artifact_list"} <= tools)
        recalled_payload = json.loads(recalled.content[0].text)
        self.assertEqual(recalled_payload["results"][0]["source"], "alpha:a.md")
        self.assertIn("BM25", recalled_payload["results"][0]["why"])
        symbol_payload = json.loads(symbols.content[0].text)
        self.assertEqual(symbol_payload["symbols"][0]["source"], "alpha:mod.py:4")
        self.assertEqual(symbol_payload["symbols"][0]["signature"], "def recall(query: str):")


if __name__ == "__main__":
    unittest.main()
