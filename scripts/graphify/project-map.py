#!/usr/bin/env python3
"""Opt-in project maps. Standard-library supervisor; no project code is imported."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
SCHEMA = 1
VERSION = "0.9.95"
SUFFIXES = {".java", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"}
EXCLUDED = {"node_modules", "vendor", "venv", "env", "__pycache__", "dist", "dist-server",
            "build", "target", "coverage", "scratch", "tmp", "temp", "data", "customer",
            "customers", "secrets", "credentials", "fixtures-private"}
SENSITIVE = re.compile(r"(^|[._-])(env|secret|secrets|credential|credentials|customer|private|token|password|auth)([._-]|$)", re.I)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], timeout=10, stderr=subprocess.DEVNULL)


def safe_path(name):
    path = PurePosixPath(name)
    return (not path.is_absolute() and bool(path.parts) and
            all(p not in {".", ".."} and not p.startswith(".") and
                p.lower() not in EXCLUDED and not SENSITIVE.search(p) for p in path.parts))


def read_source(repo, name):
    """Open every component without following symlinks, including directory swaps."""
    fd = os.open(repo, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = PurePosixPath(name).parts
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(file_fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 1_000_000:
                raise ValueError("Source must be regular and at most 1 MB")
            content = source.read(1_000_001)
            if len(content) > 1_000_000 or b"\0" in content:
                raise ValueError("Invalid source contents")
            return content
    finally:
        os.close(fd)


def settings(repo, config_path):
    common = Path(os.fsdecode(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")).strip()).resolve()
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    policy = config.get("repositories", {}).get(str(common.parent), {})
    return common, policy


def snapshot(repo, policy, common):
    roots = policy.get("roots", [])
    if not roots or not all(isinstance(r, str) and safe_path(r) for r in roots):
        raise ValueError("Explicit safe source roots are required (no '.' or hidden roots)")
    names = git(repo, "ls-files", "-z", "--cached").split(b"\0")
    if policy.get("includeUntracked") is True:
        names += git(repo, "ls-files", "-z", "--others", "--exclude-standard").split(b"\0")
    files = {}
    total_bytes = 0
    for raw in sorted(set(names)):
        name = os.fsdecode(raw)
        if (not safe_path(name) or PurePosixPath(name).suffix not in SUFFIXES or
                not any(name == r or name.startswith(r.rstrip("/") + "/") for r in roots)):
            continue
        try:
            files[name] = read_source(repo, name)
            total_bytes += len(files[name])
        except (FileNotFoundError, NotADirectoryError):
            continue  # Tracked deletions are represented by absence in the manifest.
        except OSError as error:
            # Symlinks are excluded; other read failures invalidate the snapshot.
            if error.errno in (40,):
                continue
            raise
        if len(files) > 4000 or total_bytes > 64_000_000:
            raise ValueError("Source budget exceeded (4000 files / 64 MB)")
    provenance = {
        "schema": SCHEMA, "tool": VERSION, "lock": digest((HERE / "requirements.lock").read_bytes()),
        "adapter": digest((HERE / "extract.py").read_bytes() + (HERE / "project-map.py").read_bytes()),
        "repo": str(common), "worktree": str(repo),
        "head": git(repo, "rev-parse", "HEAD").decode().strip(),
        "branch": git(repo, "rev-parse", "--abbrev-ref", "HEAD").decode().strip(),
        "policy": policy, "files": {name: digest(content) for name, content in files.items()},
    }
    return digest(encoded(provenance).encode()), provenance, files


def atomic_json(path, value):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as handle:
        tmp = Path(handle.name)
        handle.write(encoded(value))
    os.replace(tmp, path)


def prepare(repo, policy, common, cache, state, provenance, files):
    with (cache / "prepare.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"state": "preparing", "reason": "Another preparation holds the lock"}
        artifact = cache / (state + ".json")
        if not artifact.exists():
            atomic_json(cache / "status.json", {"state": "preparing", "identity": state})
            try:
                with tempfile.TemporaryDirectory(prefix="snapshot-", dir=cache) as tmp:
                    work = Path(tmp)
                    source = work / "source"
                    source.mkdir()
                    for name, content in files.items():
                        destination = source / name
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.write_bytes(content)
                    # -I ignores PYTHONPATH, user site packages and the project's cwd.
                    env = {"PATH": "/usr/bin:/bin", "HOME": str(work), "LANG": "C.UTF-8",
                           "GRAPHIFY_OUT": str(work / "extract-cache"), "OMP_NUM_THREADS": "1"}
                    python = HERE / "venv/bin/python"
                    output = work / "graph.json"
                    timeout = max(1, min(45, int(policy.get("extractionTimeoutSeconds", 45))))
                    subprocess.run([str(python), "-I", str(HERE / "extract.py"), str(source), str(output)],
                                   cwd=work, env=env, timeout=timeout, check=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    if output.stat().st_size > 64_000_000:
                        raise ValueError("Graph output exceeds 64 MB")
                    graph = json.loads(output.read_text())
                    current, _, _ = snapshot(repo, policy, common)
                    if state != current:
                        raise ValueError("Sources changed during extraction; prepare again")
                    atomic_json(artifact, {"provenance": provenance, "graph": graph})
                os.chmod(artifact, 0o600)
            except Exception as error:
                atomic_json(cache / "status.json", {"state": "error", "reason": type(error).__name__, "identity": state})
                raise
        atomic_json(cache / "status.json", {"state": "ready", "identity": state})
        return {"state": "ready", "identity": state, "files": len(files)}


def query(graph, text):
    terms = set(re.findall(r"[a-z0-9_]+", text.lower()))
    if not terms:
        return {"matches": [], "edges": []}
    ranked = []
    for node in graph["nodes"]:
        label = str(node.get("label", node.get("id", "")))
        haystack = (label + " " + str(node.get("source_file", ""))).lower()
        score = sum(term in haystack for term in terms) + 3 * (label.lower() == text.lower())
        if score and node.get("source_file"):
            ranked.append((score, node))
    ranked.sort(key=lambda item: (-item[0], str(item[1].get("id"))))
    nodes = [node for _, node in ranked[:12]]
    ids = {node["id"] for node in nodes}
    # Edges are static evidence only; preserve upstream inference tags.
    all_edges = [edge for edge in graph["edges"] if edge.get("source") in ids or edge.get("target") in ids]
    edges = all_edges[:24]
    return {"matches": [{k: n.get(k) for k in ("id", "label", "source_file", "source_location", "line", "kind")} for n in nodes],
            "edges": edges, "truncated": len(ranked) > 12 or len(all_edges) > 24}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "status", "query", "guidance"])
    parser.add_argument("text", nargs="?", default="")
    parser.add_argument("--repo", default=os.getcwd())
    parser.add_argument("--config", type=Path, default=Path.home() / ".config/cli/graphify.json")
    parser.add_argument("--cache", type=Path, default=Path.home() / ".cache/cli-graphify")
    args = parser.parse_args()
    started = time.monotonic()
    result = {"state": "error"}
    cache = None
    budget = 6000
    try:
        repo = Path(args.repo).resolve()
        top = Path(os.fsdecode(git(repo, "rev-parse", "--show-toplevel")).strip()).resolve()
        if repo != top:
            raise ValueError("Use a repository/worktree root")
        common, policy = settings(repo, args.config)
        if policy.get("enabled") is not True:
            print(encoded({"state": "disabled"}))
            return
        budget = max(1024, min(12000, int(policy.get("outputBytes", 6000))))
        cache = args.cache / digest(str(common).encode())[:20] / digest(str(repo).encode())[:20]
        cache.mkdir(mode=0o700, parents=True, exist_ok=True)
        state, provenance, files = snapshot(repo, policy, common)
        status_path = cache / "status.json"
        status = json.loads(status_path.read_text()) if status_path.exists() else {"state": "missing"}
        result = dict(status)
        if status.get("identity") and status["identity"] != state:
            result = {"state": "stale"}
        if args.command == "prepare":
            result = prepare(repo, policy, common, cache, state, provenance, files)
        result["provenance"] = {k: v for k, v in provenance.items() if k not in {"files", "policy"}}
        result["identity"] = state
        if args.command == "query" and result["state"] == "ready":
            artifact = json.loads((cache / (state + ".json")).read_text())
            result.update(query(artifact["graph"], args.text))
            result["caution"] = "Static AST evidence; inferred/unresolved edges do not prove runtime behavior. Inspect exact source before edits."
        if args.command == "guidance":
            command = f"python3 -I {shlex.quote(str(HERE / 'project-map.py'))}"
            result["guidance"] = (f"Optional local project map ({result['state']}): for exploratory work use {command} query 'symbols or dependencies' "
                                  f"--repo {shlex.quote(str(repo))}. Use prepare after edits or when stale/missing. "
                                  "Inspect exact source before edits; inferred edges are not runtime proof. "
                                  "Skip for trivial edits. If unavailable, use ordinary source tools. Do not load a full graph report.")
        # Revalidate after loading/querying an artifact, too.
        if args.command in {"query", "guidance"} and snapshot(repo, policy, common)[0] != state:
            result = {"state": "stale", "reason": "Sources changed during query"}
    except Exception as error:
        result = {"state": "error", "reason": type(error).__name__, "hint": "Check setup/config and prepare again; ordinary source tools remain available"}
        if isinstance(error, ValueError):
            result["detail"] = str(error)[:200]
    result.setdefault("truncated", False)
    while len(encoded(result).encode()) + 1 > budget:
        result["truncated"] = True
        if result.get("edges"):
            result["edges"].pop()
        elif result.get("matches"):
            result["matches"].pop()
        else:
            result = {"state": result["state"], "truncated": True, "reason": "Metadata exceeds output budget"}
            break
    output = encoded(result)
    if cache:
        event = {"command": args.command, "state": result["state"], "elapsedMs": round((time.monotonic() - started) * 1000),
                 "outputBytes": len(output.encode()) + 1, "truncated": result["truncated"], "time": time.time()}
        try:
            with (cache / "metrics.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                metrics = cache / "metrics.jsonl"
                if metrics.exists() and metrics.stat().st_size > 1_000_000:
                    os.replace(metrics, cache / "metrics.previous.jsonl")
                with metrics.open("a") as log:
                    log.write(encoded(event) + "\n")
        except OSError:
            pass  # Instrumentation must not make source exploration unavailable.
    print(output)


if __name__ == "__main__":
    main()
