#!/usr/bin/env python3
"""Offline matched tool replay, not an agent/token-efficiency benchmark. No model calls."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--wrapper", type=Path, default=Path.home() / ".local/share/cli-graphify/current/project-map.py")
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
wrapper = args.wrapper.resolve()

with tempfile.TemporaryDirectory(prefix="graphify-replay-") as tmp:
    root = Path(tmp)
    repo = root / "repo"
    source = repo / "src"
    source.mkdir(parents=True)
    originals = {"src/maths.py": "def total(a, b):\n    return a + b\n",
                 "src/use.py": "from maths import total\ndef run():\n    return total(1, 2)\n",
                 "src/greet.ts": "export function greet(name: string) { return name; }\n",
                 "src/Sample.java": "class Sample { int add(int a, int b) { return a+b; } }\n"}
    for name, text in originals.items():
        (repo / name).write_text(text)
    def git(*argv):
        env = {**os.environ, "GIT_AUTHOR_DATE": "2026-10-25T00:00:00Z", "GIT_COMMITTER_DATE": "2026-10-25T00:00:00Z"}
        return subprocess.check_output(["git", "-C", str(repo), *argv], env=env, stderr=subprocess.DEVNULL).decode().strip()
    git("init", "-qb", "main")
    git("add", ".")
    git("-c", "user.name=Graphify replay", "-c", "user.email=replay@example.test", "commit", "-qm", "fixture")
    revision = git("rev-parse", "HEAD")
    config = root / "config.json"
    config.write_text(json.dumps({"repositories": {str(repo): {"enabled": True, "roots": ["src"]}}}))
    def mapped(command, text=""):
        raw = subprocess.check_output(["python3", "-I", str(wrapper), command, text, "--repo", str(repo),
                                       "--config", str(config), "--cache", str(root / "cache")], timeout=60)
        return json.loads(raw), len(raw)
    started = time.monotonic()
    prepared, _ = mapped("prepare")
    if prepared["state"] != "ready":
        raise SystemExit(f"Preparation failed: {prepared}")
    preparation_ms = round(1000 * (time.monotonic() - started))
    guidance, _ = mapped("guidance")
    rows = []
    for task, symbol, files in [("local-edit", "greet", ["src/greet.ts"]),
                                 ("cross-file-investigation", "total", ["src/maths.py", "src/use.py"])]:
        for assisted in [False, True]:
            for name, text in originals.items():
                (repo / name).write_text(text)
            started = time.monotonic()
            if assisted:
                evidence, exploration_bytes = mapped("query", symbol)
                evidence_ok = evidence["state"] == "ready" and bool(evidence.get("matches"))
                if task == "cross-file-investigation":
                    evidence_ok &= any(e["relation"] == "calls" and e["source_file"] == "src/use.py" for e in evidence.get("edges", []))
            else:
                raw = subprocess.check_output(["rg", "-n", symbol, "src"], cwd=repo)
                exploration_bytes = len(raw)
                evidence_ok = all(name.encode() in raw for name in files)
            # Both routes inspect exact source; this is deterministic tool replay.
            read_bytes = sum(len((repo / name).read_bytes()) for name in files)
            achieved = bool(evidence_ok)
            if task == "local-edit":
                file = repo / files[0]
                file.write_text(file.read_text().replace("function greet(", "function hello("))
                achieved &= "function hello(" in file.read_text() and "function greet(" not in file.read_text()
            rows.append({"task": task, "graphAssisted": assisted, "baseRevision": revision,
                         "modelSettings": None, "initialGraphGuidanceBytes": len(guidance["guidance"].encode()) if assisted else 0,
                         "explorationReads": 1, "exactSourceReads": len(files), "sourceBytesRead": read_bytes,
                         "explorationOutputBytes": exploration_bytes, "elapsedMs": round(1000 * (time.monotonic() - started)),
                         "inputTokens": None, "outputTokens": None, "cacheTokens": None,
                         "providerCredits": None, "finalTestResult": "static fixture assertions passed" if achieved else "failed",
                         "intendedOutcomeAchieved": achieved})
    report = {"kind": "offline-tool-replay", "graphifyVersion": "0.9.95", "modelRequests": 0,
              "preparationMs": preparation_ms, "runs": rows,
              "limitation": "Deterministic tool compatibility replay; no live agent, runtime fix validation, token or efficiency claim."}
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    if not all(row["intendedOutcomeAchieved"] for row in rows):
        raise SystemExit("Replay assertions failed")
print(args.output)
