from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from tribeira_recall import cli
from tribeira_recall.db import Document, Store

from fakes import FakeEmbedder


class FakeSearch:
    def __init__(self, store):
        self.store = store
        self.embedder = FakeEmbedder()

    def recall(self, query, kinds=None, repo=None, k=5):
        self.embedder.query(query)
        return []


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "recall.db"

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, argv):
        output = io.StringIO()
        with redirect_stdout(output):
            code = cli.main(argv)
        return code, output.getvalue()

    def test_stats_prints_counts(self):
        with Store(self.db) as store:
            store.put_documents(
                [Document("d1", "doc", "a.md", "alpha", "alpha body")],
                FakeEmbedder().embed(["alpha body"]),
            )
        code, output = self.run_cli(["stats", "--db", str(self.db)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)["documents"], 1)

    def test_cleanup_uses_temp_database(self):
        code, output = self.run_cli(["cleanup", "--db", str(self.db), "--days", "30"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output), {"expired": 0, "deleted_files": 0})

    def test_benchmark_reports_latency_shape(self):
        with mock.patch.object(cli, "RecallSearch", FakeSearch):
            code, output = self.run_cli(["benchmark", "--db", str(self.db), "--repetitions", "3"])
        self.assertEqual(code, 0)
        result = json.loads(output)
        self.assertEqual(result["repetitions"], 3)
        self.assertIn("query_p95_ms", result)
        self.assertIn("embedding_p95_ms", result)

    def test_index_and_serve_dispatch(self):
        with mock.patch.object(cli, "index_main", return_value=7) as index_main:
            self.assertEqual(cli.main(["index", "--root", self.temp.name]), 7)
            index_main.assert_called_once_with(["--root", self.temp.name])
        with mock.patch("tribeira_recall.mcp_server.run") as run:
            self.assertEqual(cli.main(["serve"]), 0)
            run.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
