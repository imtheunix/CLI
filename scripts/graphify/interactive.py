#!/usr/bin/env python3
"""Add/remove only this integration's optional project skill; preserve existing instructions."""
import argparse
from pathlib import Path
import shlex
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--repo", required=True, type=Path)
parser.add_argument("--assistant", required=True, choices=["claude", "codex"])
parser.add_argument("--remove", action="store_true")
args = parser.parse_args()
repo = args.repo.resolve()
root = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "--show-toplevel"], text=True).strip()
if str(repo) != str(Path(root).resolve()):
    raise SystemExit("Use a repository root")
base = ".claude" if args.assistant == "claude" else ".agents"
parts = [base, "skills", "cli-local-project-map"]
target = repo
for part in parts:
    target /= part
    if target.is_symlink():
        raise SystemExit("Refusing a symlink in the skill path")
skill = target / "SKILL.md"
wrapper = Path.home() / ".local/share/cli-graphify/current/project-map.py"
body = f"""---
name: cli-local-project-map
description: Use the opt-in local project map for repository symbol/dependency exploration when useful; skip trivial edits.
---

<!-- Owned by CLI Graphify integration; no upstream installer or hooks. -->
Run `python3 -I {shlex.quote(str(wrapper))} query 'relevant symbols' --repo {shlex.quote(str(repo))}`.
Run the same command with `status` or `prepare` (without query text) for missing/stale maps.
The repository must be explicitly enabled in ~/.config/cli/graphify.json.
Read exact source before edits. Static inferred/unresolved edges do not prove runtime relationships.
If unavailable, use ordinary source tools. Skip graph queries for trivial edits.
Do not load a full graph report, enable semantic extraction, or dispatch extraction agents.
"""
if args.remove:
    if skill.is_symlink() or not skill.exists() or skill.read_text() != body:
        raise SystemExit("Refusing to remove missing or modified guidance; review manually")
    skill.unlink()
    target.rmdir()
    print(f"Removed {skill}")
else:
    target.mkdir(parents=True, exist_ok=True)
    # Exclusive creation refuses existing instructions, including symlinks.
    with skill.open("x") as file:
        file.write(body)
    print(f"Created {skill}; review before optionally committing it")
