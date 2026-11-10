from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import sqlite3
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Iterator

from .config import database_path
from .db import Document, Store
from .embeddings import Embedder, LocalEmbedder
from .extract import CODE_SUFFIXES, extract_code, extract_document, file_hash
from .memory_source import read_memories

SKIPPED_DIRS = {".git", ".jobs", "node_modules", ".venv", "venv", "target", "dist", "build", "__pycache__", ".cache"}
MAX_FILE_BYTES = 2_000_000


@dataclass(slots=True)
class IndexStats:
    repos: int = 0
    files: int = 0
    unchanged_files: int = 0
    parsed_documents: int = 0
    changed_documents: int = 0
    deleted_documents: int = 0
    elapsed_ms: float = 0.0


class Indexer:
    def __init__(self, store: Store, embedder: Embedder | None = None):
        self.store = store
        self.embedder = embedder or LocalEmbedder()
        self.stats = IndexStats()
        self._pending: list[Document] = []
        self._pending_states: dict[str, tuple[str, str]] = {}

    def run(
        self,
        root: Path,
        *,
        global_docs: bool = True,
        jobs_db: Path | None = None,
        experiments: Path | None = None,
        memory: bool = True,
    ) -> IndexStats:
        self.stats = IndexStats()
        started = time.perf_counter()
        repos = discover_repos(root)
        self.stats.repos = len(repos)
        active_origins: set[str] = set()
        for repo in repos:
            for path in source_files(repo):
                self._index_file(path, repo, repo.name)
                active_origins.add(str(path))
        if global_docs:
            docs = root / "docs"
            if docs.is_dir():
                for path in walk_files(docs):
                    if path.suffix.lower() in {".md", ".mdx", ".txt"}:
                        self._index_file(path, docs, None)
                        active_origins.add(str(path))
        if experiments and experiments.is_dir():
            for results in sorted(experiments.glob("*/results.jsonl")):
                self._index_file(results, results.parent, None)
                active_origins.add(str(results))
        known_file_origins = {
            row[0]
            for row in self.store.db.execute("SELECT DISTINCT origin FROM documents WHERE origin LIKE '/%' ")
        }
        for missing in known_file_origins - active_origins:
            self.stats.deleted_documents += self.store.delete_origin(missing)
        active_state_keys = {f"file:{origin}" for origin in active_origins}
        stale_states = [
            row[0]
            for row in self.store.db.execute("SELECT source FROM source_state WHERE source LIKE 'file:%'")
            if row[0] not in active_state_keys
        ]
        with self.store.db:
            self.store.db.executemany("DELETE FROM source_state WHERE source=?", ((key,) for key in stale_states))
        self._flush()
        if jobs_db and jobs_db.is_file():
            self._index_jobs(jobs_db)
        self._flush()
        if memory:
            memories = read_memories()
            self._upsert(memories)
            self.stats.parsed_documents += len(memories)
        self.stats.elapsed_ms = (time.perf_counter() - started) * 1000
        return self.stats

    def _index_file(self, path: Path, base: Path, repo: str | None) -> None:
        self.stats.files += 1
        try:
            if path.stat().st_size > MAX_FILE_BYTES or path.is_symlink():
                return
            data = path.read_bytes()
        except OSError:
            return
        origin = str(path)
        digest = file_hash(data)
        state_key = f"file:{origin}"
        if self.store.source_hash(state_key) == digest:
            self.stats.unchanged_files += 1
            return
        if path.name == "results.jsonl":
            documents = experiment_documents(path, data)
        elif repo and path.suffix in CODE_SUFFIXES:
            documents = extract_code(path, base, data)
        elif path.suffix.lower() in {".md", ".mdx", ".txt"} or path.name == "AGENTS.md":
            documents = extract_document(path, base, repo, data)
        else:
            documents = []
        self.stats.parsed_documents += len(documents)
        self.stats.changed_documents += len(documents)
        self._pending.extend(documents)
        self._pending_states[origin] = (state_key, digest)
        if len(self._pending) >= 256 or len(self._pending_states) >= 256:
            self._flush()

    def _flush(self) -> None:
        if not self._pending_states:
            return
        documents = list({doc.doc_key: doc for doc in self._pending}.values())
        vectors = self.embedder.embed([f"{doc.title}\n{doc.content}"[:1200] for doc in documents])
        self.stats.deleted_documents += self.store.replace_origins(documents, vectors, self._pending_states)
        self._pending = []
        self._pending_states = {}

    def _index_jobs(self, path: Path) -> None:
        uri = f"file:{path}?mode=ro"
        db = sqlite3.connect(uri, uri=True)
        db.row_factory = sqlite3.Row
        try:
            columns = {row[1] for row in db.execute("PRAGMA table_info(orchestrator_jobs)")}
            wanted = ["id", "title", "prompt", "state", "merge_result", "last_error", "session_id"]
            wanted.extend(sorted(name for name in columns if "refute" in name or "verdict" in name))
            selected = list(dict.fromkeys(name for name in wanted if name in columns))
            if "id" not in selected:
                return
            rows = db.execute(f"SELECT {', '.join(selected)} FROM orchestrator_jobs")
            documents = []
            active_keys = []
            for row in rows:
                values = {key: row[key] for key in selected}
                job_id = str(values["id"])
                body = "\n".join(
                    f"{key}: {str(value)[:2000]}" for key, value in values.items() if value is not None
                )[:16000]
                digest = hashlib.sha256(body.encode()).hexdigest()
                key = f"job:{job_id}"
                active_keys.append(key)
                documents.append(
                    Document(
                        doc_key=key,
                        kind="job",
                        source=f"cloudcli:orchestrator_jobs:{job_id}",
                        origin="cloudcli",
                        title=str(values.get("title") or job_id)[:200],
                        content=body,
                        content_hash=digest,
                    )
                )
            self.stats.parsed_documents += len(documents)
            self.stats.changed_documents += self._upsert(documents)
            old = {row[0] for row in self.store.db.execute("SELECT doc_key FROM documents WHERE kind='job'")}
            self.stats.deleted_documents += self.store.delete_documents(sorted(old - set(active_keys)))
        finally:
            db.close()

    def _upsert(self, documents: list[Document], force: bool = False) -> int:
        if not documents:
            return 0
        documents = list({doc.doc_key: doc for doc in documents}.values())
        existing = self.store.existing_hashes([doc.doc_key for doc in documents])
        changed = documents if force else [
            doc for doc in documents if doc.doc_key not in existing or existing[doc.doc_key][1] != doc.content_hash
        ]
        if not changed:
            return 0
        vectors = self.embedder.embed([f"{doc.title}\n{doc.content}"[:1200] for doc in changed])
        return self.store.put_documents(changed, vectors)


def discover_repos(root: Path) -> list[Path]:
    root = root.resolve()
    if (root / ".git").exists():
        return [root]
    repos: list[Path] = []
    for current, dirs, _files in os.walk(root):
        path = Path(current)
        is_repo = (path / ".git").exists()
        dirs[:] = sorted(d for d in dirs if d not in SKIPPED_DIRS and not d.startswith(".tjob"))
        if is_repo:
            repos.append(path)
            dirs[:] = [d for d in dirs if d != ".jobs"]
    return repos


def source_files(repo: Path) -> Iterator[Path]:
    for path in walk_files(repo):
        if path.name == "AGENTS.md" or path.suffix in CODE_SUFFIXES:
            yield path
        elif path.suffix.lower() in {".md", ".mdx", ".txt"} and "docs" in path.relative_to(repo).parts:
            yield path


def walk_files(root: Path) -> Iterator[Path]:
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIPPED_DIRS and not Path(current, d).is_symlink())
        for name in sorted(files):
            path = Path(current, name)
            if not path.is_symlink():
                yield path


def experiment_documents(path: Path, data: bytes) -> list[Document]:
    documents = []
    for line_number, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
            content = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))[:6000]
        except json.JSONDecodeError:
            content = line[:6000]
        digest = hashlib.sha256(line.encode()).hexdigest()
        documents.append(
            Document(
                doc_key=f"experiment:{path.parent.name}:{line_number}",
                kind="experiment",
                source=f"{path.parent.name}/results.jsonl:{line_number}",
                origin=str(path),
                title=f"experiment {path.parent.name} result {line_number}",
                content=content,
                content_hash=digest,
            )
        )
    return documents


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Incrementally index local knowledge into recall.db")
    parser.add_argument("--root", type=Path, default=Path("~/Tribeira").expanduser())
    parser.add_argument("--db", type=Path, default=database_path())
    parser.add_argument("--jobs-db", type=Path, default=Path("~/.cloudcli/auth.db").expanduser())
    parser.add_argument("--experiments", type=Path, default=Path("~/.local/share/tribeira/experiments").expanduser())
    parser.add_argument("--no-global-docs", action="store_true")
    parser.add_argument("--no-jobs", action="store_true")
    parser.add_argument("--no-experiments", action="store_true")
    parser.add_argument("--no-memory", action="store_true")
    args = parser.parse_args(argv)
    args.db.parent.mkdir(parents=True, exist_ok=True)
    with open(f"{args.db}.lock", "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with Store(args.db) as store:
            indexer = Indexer(store)
            stats = indexer.run(
                args.root,
                global_docs=not args.no_global_docs,
                jobs_db=None if args.no_jobs else args.jobs_db,
                experiments=None if args.no_experiments else args.experiments,
                memory=not args.no_memory,
            )
            print(json.dumps({"index": asdict(stats), "store": store.counts()}, separators=(",", ":")))
    return 0
