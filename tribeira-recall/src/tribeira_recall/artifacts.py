from __future__ import annotations

import hashlib
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .config import artifact_root, owner_name
from .db import Document, Store
from .embeddings import Embedder, LocalEmbedder

ARTIFACT_TYPES = {"log", "test", "report", "verdict", "patch", "plan", "json", "other"}
SECRET_PATTERNS = [
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(rb"(?i)\b(?:api[_-]?key|secret|password|token|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*['\"]?[\w/+=-]{16,}"),
    re.compile(rb"\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b"),
    re.compile(rb"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
]


def reject_secrets(content: bytes) -> None:
    for pattern in SECRET_PATTERNS:
        if pattern.search(content):
            raise ValueError("artifact refused: content matches a secret/key pattern")


class ArtifactStore:
    def __init__(self, store: Store, root: Path | None = None, embedder: Embedder | None = None):
        self.store = store
        self.root = (root or artifact_root()).resolve()
        self.embedder = embedder or LocalEmbedder()

    def put(
        self,
        type: str,
        summary: str,
        *,
        content: str | None = None,
        path: str | None = None,
        job: str | None = None,
        session: str | None = None,
        owner: str | None = None,
    ) -> dict:
        if type not in ARTIFACT_TYPES:
            raise ValueError(f"type must be one of {', '.join(sorted(ARTIFACT_TYPES))}")
        if (content is None) == (path is None):
            raise ValueError("provide exactly one of content or path")
        if not summary.strip():
            raise ValueError("summary is required")
        data = content.encode() if content is not None else Path(path).expanduser().read_bytes()  # type: ignore[arg-type]
        if len(data) > 50_000_000:
            raise ValueError("artifact exceeds 50 MB")
        reject_secrets(data)
        owner = owner or owner_name()
        namespace = _safe(job or session or owner)
        artifact_id = f"a_{uuid.uuid4().hex[:20]}"
        directory = self.root / namespace
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        destination = directory / artifact_id
        created_file = False
        inserted_row = False
        try:
            with destination.open("xb") as output:
                output.write(data)
            created_file = True
            os.chmod(destination, 0o400)
            sha256 = hashlib.sha256(data).hexdigest()
            created_at = datetime.now(timezone.utc).isoformat()
            with self.store.db:
                self.store.db.execute(
                    """INSERT INTO artifacts
                       (id, job_id, session_id, owner, type, size, sha256, path, created_at, summary)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        artifact_id,
                        job,
                        session,
                        owner,
                        type,
                        len(data),
                        sha256,
                        str(destination),
                        created_at,
                        summary.strip()[:500],
                    ),
                )
            inserted_row = True
            self._index(artifact_id, destination, summary, data)
        except Exception:
            if created_file:
                destination.unlink(missing_ok=True)
            if inserted_row:
                with self.store.db:
                    self.store.db.execute("DELETE FROM artifacts WHERE id=?", (artifact_id,))
            raise
        return {"id": artifact_id, "sha256": sha256, "size": len(data), "path": str(destination)}

    def get(self, artifact_id: str, start_line: int = 1, end_line: int | None = None) -> dict:
        row = self.store.db.execute("SELECT * FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
        if not row:
            raise ValueError("unknown artifact id")
        self._check_path(row["path"])
        start_line = max(1, start_line)
        end_line = end_line if end_line is not None else start_line + 199
        if end_line < start_line:
            raise ValueError("end_line must be >= start_line")
        end_line = min(end_line, start_line + 199)
        digest = hashlib.sha256()
        size = 0
        total_lines = 0
        selected = []
        with Path(row["path"]).open("rb") as artifact:
            for raw_line in artifact:
                total_lines += 1
                size += len(raw_line)
                digest.update(raw_line)
                if start_line <= total_lines <= end_line:
                    selected.append(raw_line.decode("utf-8", "replace").rstrip("\r\n"))
        actual_hash = digest.hexdigest()
        if size != row["size"] or actual_hash != row["sha256"]:
            raise ValueError("artifact checksum mismatch; refusing modified content")
        return {
            "id": artifact_id,
            "sha256": actual_hash,
            "start_line": start_line,
            "end_line": min(end_line, total_lines),
            "total_lines": total_lines,
            "content": "\n".join(selected),
        }

    def list(self, job: str | None = None, type: str | None = None, limit: int = 20) -> list[dict]:
        clauses = []
        params: list[object] = []
        if job:
            clauses.append("job_id=?")
            params.append(job)
        if type:
            clauses.append("type=?")
            params.append(type)
        params.append(max(1, min(limit, 100)))
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self.store.db.execute(
            f"""SELECT id, job_id, session_id, owner, type, size, sha256, created_at, summary
                FROM artifacts {where} ORDER BY created_at DESC LIMIT ?""",
            params,
        ).fetchall()
        return [dict(row) for row in rows]

    def cleanup(self, days: int = 30, now: datetime | None = None) -> dict:
        if days < 0:
            raise ValueError("retention days must be >= 0")
        cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=days)
        rows = self.store.db.execute("SELECT id, path FROM artifacts WHERE created_at < ?", (cutoff.isoformat(),)).fetchall()
        deleted_files = 0
        for row in rows:
            path = Path(row["path"])
            self._check_path(path, must_exist=False)
            if path.is_file() and not path.is_symlink():
                path.unlink()
                deleted_files += 1
            self.store.delete_origin(f"artifact:{row['id']}")
            with self.store.db:
                self.store.db.execute("DELETE FROM artifacts WHERE id=?", (row["id"],))
        return {"expired": len(rows), "deleted_files": deleted_files}

    def _index(self, artifact_id: str, path: Path, summary: str, data: bytes) -> None:
        text = data[:2_000_000].decode("utf-8", "replace")
        chunks = [text[offset : offset + 1400] for offset in range(0, len(text), 1400)] or [""]
        documents = [
            Document(
                doc_key=f"artifact:{artifact_id}:{number}",
                kind="artifact",
                source=f"artifact://{artifact_id}#chunk-{number}",
                origin=f"artifact:{artifact_id}",
                title=summary[:200],
                content=chunk,
                content_hash=hashlib.sha256(chunk.encode()).hexdigest(),
            )
            for number, chunk in enumerate(chunks, 1)
        ]
        vectors = self.embedder.embed([f"{summary}\n{doc.content}" for doc in documents])
        self.store.put_documents(documents, vectors)

    def _check_path(self, value: str | Path, *, must_exist: bool = True) -> None:
        path = Path(value).resolve()
        path.relative_to(self.root)
        if must_exist and not path.is_file():
            raise ValueError("artifact file is missing")


def _safe(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]", "_", value)[:80].strip(".")
    if not cleaned:
        raise ValueError("job/session/owner must contain a safe filename character")
    return cleaned
