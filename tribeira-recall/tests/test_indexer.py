from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from tribeira_recall.db import Store
from tribeira_recall.indexer import Indexer, discover_repos

from fakes import FakeEmbedder


class IndexerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "alpha"
        (self.repo / ".git").mkdir(parents=True)
        (self.repo / "docs" / "adr").mkdir(parents=True)
        self.store = Store(self.root / "recall.db")
        self.embedder = FakeEmbedder()

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_code_docs_and_incremental_reindex(self):
        source = self.repo / "mod.py"
        source.write_text('def alpha(value: int) -> int:\n    """Compute alpha."""\n    return value\n')
        (self.repo / "other.ts").write_text('/** Greeting. */\nexport function greet(name: string) { return name; }\n')
        (self.repo / "lib.rs").write_text('/// Rust docs\npub fn compute(value: i32) -> i32 { value }\n')
        (self.repo / "root.md").write_text("not selected")
        (self.repo / "docs" / "adr" / "001.md").write_text("# Decision\nUse local SQLite.")
        (self.repo / "AGENTS.md").write_text("Run focused tests.")
        indexer = Indexer(self.store, self.embedder)
        stats = indexer.run(self.root, global_docs=False, memory=False)
        self.assertEqual(discover_repos(self.root), [self.repo])
        self.assertEqual(stats.repos, 1)
        self.assertGreaterEqual(stats.changed_documents, 5)
        symbols = self.store.db.execute("SELECT title, signature, content FROM documents WHERE kind IN ('symbol','export')").fetchall()
        self.assertEqual({row["title"] for row in symbols}, {"alpha", "greet", "compute"})
        self.assertIn("Compute alpha", next(row["content"] for row in symbols if row["title"] == "alpha"))
        calls = self.embedder.calls
        second = indexer.run(self.root, global_docs=False, memory=False)
        self.assertEqual(second.changed_documents, 0)
        self.assertEqual(second.unchanged_files, 5)
        self.assertEqual(self.embedder.calls, calls)
        source.write_text('def beta() -> None:\n    """New beta."""\n    return None\n')
        indexer.run(self.root, global_docs=False, memory=False)
        titles = {row[0] for row in self.store.db.execute("SELECT title FROM documents WHERE kind='symbol'")}
        self.assertIn("beta", titles)
        self.assertNotIn("alpha", titles)
        original = source.read_bytes()
        source.unlink()
        indexer.run(self.root, global_docs=False, memory=False)
        self.assertNotIn("beta", {row[0] for row in self.store.db.execute("SELECT title FROM documents WHERE kind='symbol'")})
        source.write_bytes(original)
        indexer.run(self.root, global_docs=False, memory=False)
        self.assertIn("beta", {row[0] for row in self.store.db.execute("SELECT title FROM documents WHERE kind='symbol'")})

    def test_same_repo_names_do_not_collide_and_failed_embedding_preserves_old_rows(self):
        first = self.root / "one" / "api"
        second = self.root / "two" / "api"
        for repo in (first, second):
            (repo / ".git").mkdir(parents=True)
            (repo / "mod.py").write_text("def same_name():\n    return 1\n")
        Indexer(self.store, self.embedder).run(self.root, global_docs=False, memory=False)
        self.assertEqual(self.store.db.execute("SELECT count(DISTINCT doc_key) FROM documents WHERE title='same_name'").fetchone()[0], 2)
        source = first / "mod.py"
        source.write_text("def replacement():\n    return 2\n")
        old_hash = self.store.source_hash(f"file:{source}")
        self.embedder.fail = True
        with self.assertRaisesRegex(RuntimeError, "injected"):
            Indexer(self.store, self.embedder).run(self.root, global_docs=False, memory=False)
        self.assertIsNotNone(self.store.db.execute("SELECT 1 FROM documents WHERE title='same_name' AND origin=?", (str(source),)).fetchone())
        self.assertEqual(self.store.source_hash(f"file:{source}"), old_hash)

    def test_jobs_and_experiment_sources(self):
        jobs = self.root / "auth.db"
        db = sqlite3.connect(jobs)
        db.execute("CREATE TABLE orchestrator_jobs (id TEXT, title TEXT, prompt TEXT, state TEXT, merge_result TEXT, last_error TEXT, review_verdict TEXT)")
        db.execute("INSERT INTO orchestrator_jobs VALUES ('j1','Fix retry','repair retry loop','failed',NULL,'timeout in worker','REFUTE missing regression')")
        db.commit()
        db.close()
        experiments = self.root / "experiments" / "e1"
        experiments.mkdir(parents=True)
        (experiments / "results.jsonl").write_text(json.dumps({"pass": True, "calls": 3}) + "\n")
        stats = Indexer(self.store, self.embedder).run(
            self.root, global_docs=False, jobs_db=jobs, experiments=experiments.parent, memory=False
        )
        self.assertEqual(self.store.counts()["job"], 1)
        self.assertEqual(stats.parsed_documents, 2)
        row = self.store.db.execute("SELECT content FROM documents WHERE kind='job'").fetchone()
        self.assertIn("timeout in worker", row["content"])
        self.assertIn("REFUTE missing regression", row["content"])
        second = Indexer(self.store, self.embedder).run(
            self.root, global_docs=False, jobs_db=jobs, experiments=experiments.parent, memory=False
        )
        self.assertEqual(second.unchanged_files, 1)
        self.assertEqual(second.changed_documents, 0)


if __name__ == "__main__":
    unittest.main()
