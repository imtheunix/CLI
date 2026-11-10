from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from tribeira_recall import cli
from tribeira_recall.artifacts import ArtifactStore
from tribeira_recall.db import Document, Store

from fakes import FakeEmbedder


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / "recall.db"
        self.embedder = FakeEmbedder()
        with Store(self.db) as store:
            store.put_documents(
                [Document("a", "doc", "a.md", "hybrid ranking", "BM25 cosine fusion")],
                self.embedder.embed(["BM25 cosine fusion"]),
            )

    def tearDown(self):
        self.temp.cleanup()

    def _run(self, argv):
        output = io.StringIO()
        with redirect_stdout(output):
            code = cli.main(argv)
        return code, output.getvalue()

    def test_stats_and_cleanup_commands(self):
        code, output = self._run(["stats", "--db", str(self.db)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)["documents"], 1)

        with mock.patch.dict(os.environ, {"RECALL_ARTIFACT_ROOT": str(self.root / "artifacts")}):
            with Store(self.db) as store:
                ArtifactStore(store, self.root / "artifacts", self.embedder).put("log", "old", content="body")
            code, output = self._run(["cleanup", "--db", str(self.db), "--days", "30"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output), {"expired": 0, "deleted_files": 0})

    def test_benchmark_uses_search_without_real_model(self):
        class FakeSearch:
            def __init__(self, store):
                self.embedder = FakeEmbedder()

            def recall(self, query, k=5):
                return []

        with mock.patch.object(cli, "RecallSearch", FakeSearch):
            code, output = self._run(["benchmark", "--db", str(self.db), "--repetitions", "3"])
        self.assertEqual(code, 0)
        result = json.loads(output)
        self.assertEqual(result["documents"], 1)
        self.assertEqual(result["repetitions"], 3)
        self.assertIn("query_p95_ms", result)

    def test_index_and_serve_dispatch(self):
        with mock.patch.object(cli, "index_main", return_value=7) as index_main:
            self.assertEqual(cli.main(["index", "--root", str(self.root)]), 7)
            index_main.assert_called_once_with(["--root", str(self.root)])
        with mock.patch("tribeira_recall.mcp_server.run") as run:
            self.assertEqual(cli.main(["serve"]), 0)
            run.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
