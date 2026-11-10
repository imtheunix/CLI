from __future__ import annotations

import hashlib
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tribeira_recall.artifacts import ArtifactStore
from tribeira_recall.db import Store

from fakes import FakeEmbedder


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "recall.db")
        self.artifacts = ArtifactStore(self.store, Path(self.temp.name) / "artifacts", FakeEmbedder())

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_round_trip_checksum_ranges_and_filters(self):
        content = "\n".join(f"line {i}" for i in range(1, 151))
        created = self.artifacts.put("log", "worker log", content=content, job="j1", owner="worker")
        fetched = self.artifacts.get(created["id"])
        self.assertEqual(hashlib.sha256(fetched["content"].encode()).hexdigest(), created["sha256"])
        partial = self.artifacts.get(created["id"], 101, 150)
        self.assertEqual(partial["content"], "\n".join(f"line {i}" for i in range(101, 151)))
        self.assertEqual(partial["total_lines"], 150)
        self.artifacts.put("test", "test output", content="ok", job="j2")
        self.assertEqual(len(self.artifacts.list("j1")), 1)
        self.assertEqual(self.artifacts.list(type="test")[0]["summary"], "test output")
        self.assertTrue(self.store.db.execute("SELECT 1 FROM documents WHERE kind='artifact'").fetchone())

    def test_path_input_and_write_once_ids(self):
        source = Path(self.temp.name) / "report.txt"
        source.write_text("report body")
        first = self.artifacts.put("report", "report", path=str(source))
        second = self.artifacts.put("report", "report", path=str(source))
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(self.artifacts.get(first["id"])["content"], "report body")
        with self.assertRaises(FileExistsError):
            with Path(first["path"]).open("xb") as output:
                output.write(b"replacement")

    def test_secret_refusal(self):
        for secret in ["-----BEGIN PRIVATE KEY-----\nabc", "api_key = abcdefghijklmnopqrstuvwxyz", "token: ghp_abcdefghijklmnopqrstuvwxyz"]:
            with self.subTest(secret=secret), self.assertRaisesRegex(ValueError, "refused"):
                self.artifacts.put("log", "bad", content=secret)
        self.assertEqual(self.artifacts.list(), [])

    def test_modified_checksum_and_negative_retention_are_rejected(self):
        created = self.artifacts.put("report", "immutable", content="expected")
        path = Path(created["path"])
        path.chmod(0o600)
        path.write_text("tampered")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.artifacts.get(created["id"])
        with self.assertRaisesRegex(ValueError, "days"):
            self.artifacts.cleanup(-1)

    def test_retention_cleanup_deletes_rows_files_and_index(self):
        old = self.artifacts.put("log", "old", content="old body")
        recent = self.artifacts.put("log", "recent", content="recent body")
        old_date = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
        self.store.db.execute("UPDATE artifacts SET created_at=? WHERE id=?", (old_date, old["id"]))
        self.store.db.commit()
        missing = self.artifacts.put("log", "already missing", content="missing")
        Path(missing["path"]).unlink()
        self.store.db.execute("UPDATE artifacts SET created_at=? WHERE id=?", (old_date, missing["id"]))
        self.store.db.commit()
        result = self.artifacts.cleanup()
        self.assertEqual(result, {"expired": 2, "deleted_files": 1})
        self.assertFalse(Path(old["path"]).exists())
        self.assertTrue(Path(recent["path"]).exists())
        self.assertEqual([row["id"] for row in self.artifacts.list()], [recent["id"]])
        self.assertFalse(self.store.db.execute("SELECT 1 FROM documents WHERE doc_key LIKE ?", (f"artifact:{old['id']}:%",)).fetchone())


if __name__ == "__main__":
    unittest.main()
