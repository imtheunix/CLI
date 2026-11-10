#!/usr/bin/env python3
"""DeepSeek 1017 recall-MCP A/B, copied from ~/.cache/ab/bake2.py on 2026-11-10.
Three replay jobs x three reps; per-run recall indexes contain only that job's base revision.
The original bake2.py is not imported or modified.
"""
import concurrent.futures as cf
import hashlib
import itertools
import json
import os
from pathlib import Path
import shutil
import sqlite3
import statistics
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
REPO = f"{HOME}/Tribeira/tribeiracli"
ROOT = Path("/tmp/tribeira-recall-mcp-ab")
APP = f"{HOME}/.local/share/cli/app"
PACKAGE = Path(__file__).resolve().parents[1]
PYTHON = PACKAGE / ".venv/bin/python"
MODEL_CACHE = PACKAGE / ".cache/fastembed"
JOBS = {"d6a7b815": "5922b497", "20450fe0": "ae3260fd", "a018c56e": "b8c37511"}
EXPECTED = {"d6a7b815": 6, "20450fe0": 4, "a018c56e": 18}
MODEL = "morph/morph-dsv41flash-1017"
ARMS = ("without_mcp", "with_mcp")
PROMPT_GUIDANCE = (
    "Tool usage: if the tribeira-recall MCP is available, start unfamiliar-code exploration with one recall "
    "call (or symbol when you already know the exact symbol), before find/grep or broad file reads. Use the "
    "returned locations for focused reads; do not repeat searches that did not help.\n\n"
)
SOURCE_SIGNATURE = hashlib.sha256(
    json.dumps({"jobs": JOBS, "model": MODEL, "arms": ARMS}, sort_keys=True).encode()
    + b"".join(path.read_bytes() for path in sorted(PACKAGE.glob("src/tribeira_recall/*.py")))
    + (PACKAGE / "pyproject.toml").read_bytes()
).hexdigest()
RUN_SIGNATURE = hashlib.sha256(SOURCE_SIGNATURE.encode() + PROMPT_GUIDANCE.encode()).hexdigest()
ports = itertools.count(9400)


def sh(cmd, cwd=None, timeout=None):
    return subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True, timeout=timeout)


def brief(job):
    db = sqlite3.connect(f"file:{HOME}/.cloudcli/auth.db?mode=ro", uri=True)
    try:
        return db.execute("select prompt from orchestrator_jobs where id=?", (job,)).fetchone()[0]
    finally:
        db.close()


def wait_up(url, proc):
    for _ in range(90):
        if sh(f"curl -s -m1 -o /dev/null {url}").returncode == 0:
            return
        time.sleep(0.5)
    proc.kill()
    raise RuntimeError(f"{url} did not start")


def prepare_indexes():
    for job, sha in JOBS.items():
        template = ROOT / f"index-{job}.db"
        manifest_path = ROOT / f"index-{job}.manifest.json"
        base = sh(f"git rev-parse {sha}^", cwd=REPO).stdout.strip()
        manifest = {"job": job, "base": base, "signature": SOURCE_SIGNATURE}
        if template.exists() and manifest_path.exists() and json.loads(manifest_path.read_text()) == manifest:
            continue
        for candidate in ROOT.glob(f"index-{job}.db*"):
            candidate.unlink()
        manifest_path.unlink(missing_ok=True)
        snapshot = ROOT / f"snapshot-{job}"
        sh(f"git worktree remove --force {snapshot} 2>/dev/null; rm -rf {snapshot}", cwd=REPO)
        added = sh(f"git worktree add -q --detach {snapshot} {sha}^", cwd=REPO)
        if added.returncode:
            raise RuntimeError(added.stderr)
        env = dict(os.environ, FASTEMBED_CACHE_PATH=str(MODEL_CACHE), RECALL_ONNX_THREADS="8")
        command = [
            str(PYTHON), "-m", "tribeira_recall", "index", "--root", str(snapshot),
            "--db", str(template), "--no-global-docs", "--no-jobs", "--no-experiments", "--no-memory",
        ]
        print(f"Indexing replay base {job}", flush=True)
        result = subprocess.run(command, cwd=PACKAGE, env=env, capture_output=True, text=True, timeout=1800)
        (ROOT / f"index-{job}.log").write_text(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError(f"Index failed for {job}: {result.stderr[-1000:]}")
        manifest_path.write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
        print(result.stdout.strip(), flush=True)


def recall_tool_calls(worktree):
    db_path = Path(HOME) / ".local/share/opencode/opencode.db"
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        session = db.execute(
            "SELECT id FROM session WHERE directory=? ORDER BY time_created DESC LIMIT 1", (str(worktree),)
        ).fetchone()
        if not session:
            return 0
        return db.execute(
            """SELECT count(*) FROM part WHERE session_id=?
               AND json_extract(data, '$.type')='tool'
               AND json_extract(data, '$.tool') LIKE 'tribeira-recall%'""",
            (session[0],),
        ).fetchone()[0]
    finally:
        db.close()


def one(job, sha, arm, rep):
    tag = f"{job}-{arm}-{rep}"
    wt = ROOT / tag
    pport = next(ports)
    ledger = ROOT / f"{tag}.ledger.jsonl"
    sh(f"git worktree remove --force {wt} 2>/dev/null; rm -rf {wt} {ledger}", cwd=REPO)
    added = sh(f"git worktree add -q --detach {wt} {sha}^", cwd=REPO)
    if added.returncode:
        raise RuntimeError(added.stderr)
    os.symlink(f"{REPO}/node_modules", f"{wt}/node_modules")
    prompt = (
        f"You are working in the git worktree {wt}, a throwaway copy for a benchmark. Do the task below fully: "
        "implement it, add or update tests for what you change, run only the tests you touched, and commit with a "
        "descriptive message. Never run `tjob`: there is no job id here.\n\n"
        + PROMPT_GUIDANCE + "Task:\n\n" + brief(job)
    )
    pacer = subprocess.Popen(
        [f"{APP}/node_modules/.bin/tsx", "morph-pacer/src/index.ts"], cwd=APP,
        env=dict(os.environ, MORPH_PACER_PORT=str(pport), MORPH_PACER_LEDGER=str(ledger)),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        wait_up(f"127.0.0.1:{pport}/pacer/usage", pacer)
        base = f"http://127.0.0.1:{pport}/v1"
        config = {
            "provider": {"morph": {"options": {"baseURL": base}}},
            "mcp": {
                "tribeira-memory": {
                    "type": "local",
                    "command": [f"{HOME}/.local/share/tripam-fixer/code/scripts/codex-memory-mcp.sh"],
                    "enabled": False,
                }
            },
        }
        environment = {"FASTEMBED_CACHE_PATH": str(MODEL_CACHE), "RECALL_ONNX_THREADS": "4"}
        if arm == "with_mcp":
            run_db = ROOT / f"{tag}.recall.db"
            shutil.copy2(ROOT / f"index-{job}.db", run_db)
            environment.update({
                "RECALL_DB": str(run_db),
                "RECALL_ARTIFACT_ROOT": str(ROOT / f"{tag}.artifacts"),
                "RECALL_OWNER": tag,
            })
            config["mcp"]["tribeira-recall"] = {
                "type": "local",
                "command": [str(PYTHON), "-m", "tribeira_recall", "serve"],
                "environment": environment,
                "enabled": True,
            }
        config_path = ROOT / f"{tag}.oc.jsonc"
        config_path.write_text(json.dumps(config))
        env = dict(os.environ, OPENCODE_CONFIG=str(config_path))
        started = time.time()
        try:
            result = subprocess.run(
                ["opencode", "run", "--dir", str(wt), "--model", MODEL, "--variant", "medium", prompt],
                cwd=wt, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=1200,
            )
            rc = result.returncode
            log = result.stdout + result.stderr
        except subprocess.TimeoutExpired as error:
            rc = "timeout"
            stdout = error.stdout.decode("utf-8", "replace") if isinstance(error.stdout, bytes) else (error.stdout or "")
            stderr = error.stderr.decode("utf-8", "replace") if isinstance(error.stderr, bytes) else (error.stderr or "")
            log = stdout + stderr
        wall = round(time.time() - started)
    finally:
        pacer.terminate()
        try:
            pacer.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pacer.kill()
    (ROOT / f"{tag}.log").write_text(log[-200000:])
    commits = sh(f"git rev-list --count {sha}^..HEAD", cwd=wt).stdout.strip()
    tests = sh(f"git diff --name-only {sha}^ {sha} | grep test", cwd=REPO).stdout.split()
    sh(f"git checkout {sha} -- {' '.join(tests)}", cwd=wt)
    test_run = sh(
        "env -u CLAUDE_CLI_PATH -u CLAUDE_CODE_EXECUTABLE -u CLAUDE_CODE_EXECPATH npx tsx "
        f"--tsconfig server/tsconfig.json --test {' '.join(tests)} 2>&1 | grep -E '^# (pass|fail)'",
        cwd=wt, timeout=600,
    )
    test_counts = test_run.stdout.split()
    hidden_pass = int(test_counts[test_counts.index("pass") + 1]) if "pass" in test_counts else 0
    hidden_fail = int(test_counts[test_counts.index("fail") + 1]) if "fail" in test_counts else -1
    entries = [json.loads(line) for line in ledger.read_text().splitlines()] if ledger.exists() else []
    per_model = {}
    for entry in entries:
        model = per_model.setdefault(entry["model"], dict(calls=0, out=0, reasoning=0, uncached=0, cached=0, retries=0))
        model["calls"] += 1
        model["out"] += entry["out"]
        model["reasoning"] += entry["reasoning"]
        model["uncached"] += entry["uncached_in"]
        model["cached"] += entry["cached_in"]
        model["retries"] += entry["retries"]
    uncached = sum(entry["uncached_in"] for entry in entries)
    cached = sum(entry["cached_in"] for entry in entries)
    turns = len(entries)
    passed = hidden_fail == 0 and hidden_pass == EXPECTED[job]
    result = dict(
        job=job, arm=arm, rep=rep, signature=RUN_SIGNATURE, valid=True, rc=rc, wall_s=wall, commits=commits,
        hidden_pass=hidden_pass, hidden_fail=hidden_fail, passed=passed, turns=turns,
        uncached=uncached, cache_hit=round(cached / max(1, cached + uncached), 3),
        recall_tool_calls=recall_tool_calls(wt),
        recall_log_mentions=log.count("tribeira-recall"), per_model=per_model,
    )
    with open(ROOT / "results.jsonl", "a") as output:
        output.write(json.dumps(result) + "\n")
    return result


def summarize(rows):
    result = {}
    for arm in ARMS:
        selected = [row for row in rows if row["arm"] == arm and row.get("valid") and row.get("signature") == RUN_SIGNATURE]
        result[arm] = {
            "runs": len(selected),
            "pass_rate": round(sum(row["passed"] for row in selected) / max(1, len(selected)), 4),
            "calls_mean": round(statistics.mean(row["turns"] for row in selected), 2) if selected else None,
            "uncached_mean": round(statistics.mean(row["uncached"] for row in selected), 2) if selected else None,
            "wall_s_mean": round(statistics.mean(row["wall_s"] for row in selected), 2) if selected else None,
            "wall_s_total": sum(row["wall_s"] for row in selected),
            "recall_calls_mean": round(statistics.mean(row.get("recall_tool_calls", 0) for row in selected), 2) if selected else None,
            "runs_using_recall": sum(row.get("recall_tool_calls", 0) > 0 for row in selected),
        }
    (ROOT / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def main():
    os.makedirs(ROOT, exist_ok=True)
    prepare_indexes()
    done = set()
    if (ROOT / "results.jsonl").exists():
        for line in (ROOT / "results.jsonl").read_text().splitlines():
            row = json.loads(line)
            if row.get("valid") and row.get("signature") == RUN_SIGNATURE:
                done.add((row["job"], row["arm"], row["rep"]))
    runs = sorted(
        ((job, sha, arm, rep) for arm in ARMS for rep in range(3) for job, sha in JOBS.items()
         if (job, arm, rep) not in done),
        key=lambda item: (item[3], item[0], item[2]),
    )
    workers = int(os.environ.get("RECALL_BAKE_WORKERS", "3"))
    with cf.ThreadPoolExecutor(workers) as executor:
        futures = {executor.submit(one, *run): run for run in runs}
        for future in cf.as_completed(futures):
            run = futures[future]
            try:
                print(json.dumps(future.result()), flush=True)
            except Exception as error:
                print("RETRYABLE_ERROR", json.dumps({"run": run, "error": repr(error)}), flush=True)
    rows = [json.loads(line) for line in (ROOT / "results.jsonl").read_text().splitlines()] if (ROOT / "results.jsonl").exists() else []
    summary = summarize(rows)
    summary["complete"] = all(summary[arm]["runs"] == 9 for arm in ARMS)
    (ROOT / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2), flush=True)
    if not summary["complete"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
