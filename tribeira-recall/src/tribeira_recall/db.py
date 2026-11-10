from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import sqlite_vec

from .config import EMBEDDING_DIMENSIONS

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    doc_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    repo TEXT,
    source TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    signature TEXT,
    line INTEGER,
    content_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS documents_kind_repo ON documents(kind, repo);
CREATE INDEX IF NOT EXISTS documents_source ON documents(source);
CREATE INDEX IF NOT EXISTS documents_title ON documents(title);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    title, content, content='documents', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO documents_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TABLE IF NOT EXISTS source_state (
    source TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    session_id TEXT,
    owner TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_job_type ON artifacts(job_id, type);
CREATE INDEX IF NOT EXISTS artifacts_created ON artifacts(created_at);
"""


@dataclass(slots=True)
class Document:
    doc_key: str
    kind: str
    source: str
    title: str
    content: str
    repo: str | None = None
    signature: str | None = None
    line: int | None = None
    content_hash: str = ""
    origin: str = ""


class Store:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.path.parent, 0o700)
        self.path.touch(mode=0o600, exist_ok=True)
        os.chmod(self.path, 0o600)
        self.db = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.enable_load_extension(True)
        sqlite_vec.load(self.db)
        self.db.enable_load_extension(False)
        self.db.executescript(SCHEMA)
        self.db.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS document_vectors USING vec0("
            f"embedding float[{EMBEDDING_DIMENSIONS}] distance_metric=cosine, kind text, repo text)"
        )
        self.db.commit()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(f"{self.path}{suffix}")
            if candidate.exists():
                os.chmod(candidate, 0o600)

    def close(self) -> None:
        self.db.close()

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def existing_hashes(self, keys: Sequence[str]) -> dict[str, tuple[int, str]]:
        if not keys:
            return {}
        found: dict[str, tuple[int, str]] = {}
        for offset in range(0, len(keys), 500):
            batch = keys[offset : offset + 500]
            marks = ",".join("?" for _ in batch)
            rows = self.db.execute(
                f"SELECT id, doc_key, content_hash FROM documents WHERE doc_key IN ({marks})", batch
            )
            found.update((row["doc_key"], (row["id"], row["content_hash"])) for row in rows)
        return found

    def put_documents(self, documents: Iterable[Document], vectors: Iterable[Sequence[float]]) -> int:
        with self.db:
            return self._put_documents(list(documents), list(vectors))

    def _put_documents(self, documents: list[Document], vectors: list[Sequence[float]]) -> int:
        count = 0
        for doc, vector in zip(documents, vectors, strict=True):
            cur = self.db.execute(
                """INSERT INTO documents
                   (doc_key, kind, repo, source, origin, title, content, signature, line, content_hash)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(doc_key) DO UPDATE SET kind=excluded.kind, repo=excluded.repo,
                   source=excluded.source, origin=excluded.origin, title=excluded.title, content=excluded.content,
                   signature=excluded.signature, line=excluded.line, content_hash=excluded.content_hash,
                   updated_at=datetime('now') RETURNING id""",
                (
                    doc.doc_key, doc.kind, doc.repo, doc.source, doc.origin, doc.title,
                    doc.content, doc.signature, doc.line, doc.content_hash,
                ),
            )
            doc_id = cur.fetchone()[0]
            self.db.execute("DELETE FROM document_vectors WHERE rowid=?", (doc_id,))
            self.db.execute(
                "INSERT INTO document_vectors(rowid, embedding, kind, repo) VALUES (?, ?, ?, ?)",
                (doc_id, sqlite_vec.serialize_float32(vector), doc.kind, doc.repo or ""),
            )
            count += 1
        return count

    def replace_origins(
        self, documents: list[Document], vectors: list[Sequence[float]], states: dict[str, tuple[str, str]]
    ) -> int:
        """Replace changed files, vectors, and their hashes in one transaction."""
        deleted = 0
        with self.db:
            for origin in states:
                keys = [row[0] for row in self.db.execute("SELECT doc_key FROM documents WHERE origin=?", (origin,))]
                deleted += self._delete_documents(keys)
            inserted = self._put_documents(documents, vectors)
            if inserted != len(documents):
                raise RuntimeError("not all replacement documents were inserted")
            for origin, (state_key, digest) in states.items():
                self._set_source_hash(state_key, digest)
        return deleted

    def delete_documents(self, keys: Sequence[str]) -> int:
        with self.db:
            return self._delete_documents(keys)

    def _delete_documents(self, keys: Sequence[str]) -> int:
        count = 0
        for offset in range(0, len(keys), 500):
            batch = list(keys[offset : offset + 500])
            if not batch:
                continue
            marks = ",".join("?" for _ in batch)
            ids = [r[0] for r in self.db.execute(f"SELECT id FROM documents WHERE doc_key IN ({marks})", batch)]
            if ids:
                id_marks = ",".join("?" for _ in ids)
                self.db.execute(f"DELETE FROM document_vectors WHERE rowid IN ({id_marks})", ids)
                self.db.execute(f"DELETE FROM documents WHERE id IN ({id_marks})", ids)
                count += len(ids)
        return count

    def delete_origin(self, origin: str) -> int:
        keys = [row[0] for row in self.db.execute("SELECT doc_key FROM documents WHERE origin=?", (origin,))]
        return self.delete_documents(keys)

    def delete_missing_origins(self, prefix: str, active: set[str]) -> int:
        rows = self.db.execute("SELECT DISTINCT origin FROM documents WHERE origin LIKE ?", (f"{prefix}%",))
        missing = [row[0] for row in rows if row[0] not in active]
        return sum(self.delete_origin(origin) for origin in missing)

    def source_hash(self, source: str) -> str | None:
        row = self.db.execute("SELECT content_hash FROM source_state WHERE source=?", (source,)).fetchone()
        return row[0] if row else None

    def set_source_hash(self, source: str, content_hash: str) -> None:
        with self.db:
            self._set_source_hash(source, content_hash)

    def _set_source_hash(self, source: str, content_hash: str) -> None:
        self.db.execute(
            """INSERT INTO source_state(source, content_hash) VALUES (?, ?)
               ON CONFLICT(source) DO UPDATE SET content_hash=excluded.content_hash,
               updated_at=datetime('now')""",
            (source, content_hash),
        )

    def counts(self) -> dict[str, int]:
        result = {"documents": self.db.execute("SELECT count(*) FROM documents").fetchone()[0]}
        result.update(
            (row[0], row[1])
            for row in self.db.execute("SELECT kind, count(*) FROM documents GROUP BY kind ORDER BY kind")
        )
        result["artifacts"] = self.db.execute("SELECT count(*) FROM artifacts").fetchone()[0]
        return result
