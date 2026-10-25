"""Safety and compatibility tests against the real pinned extractor; no model calls."""
import concurrent.futures
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]
VENV = Path(os.environ.get("CLI_GRAPHIFY_TEST_VENV", str(Path.home() / ".local/share/cli-graphify/current/venv")))


class ProjectMapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="project-map-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "test")
        self.git("config", "user.email", "test@example.test")
        self.installation = self.root / "installation"
        self.installation.mkdir()
        for name in ("project-map.py", "extract.py", "requirements.lock"):
            shutil.copyfile(SOURCE / name, self.installation / name)
        (self.installation / "venv").symlink_to(VENV.resolve(), target_is_directory=True)
        self.wrapper = self.installation / "project-map.py"
        self.cache = self.root / "cache"
        self.config = self.root / "config.json"
        self.policy = {"enabled": True, "roots": ["src"]}
        self.configure()
        self.write("src/maths.py", "def total(a, b):\n    return a + b\n")
        self.write("src/use.py", "from maths import total\ndef run():\n    return total(1, 2)\n")
        self.write("src/math.ts", "export function greet(name: string) { return name; }\n")
        self.write("src/Sample.java", "class Sample { int add(int a, int b) { return a+b; } }\n")
        self.commit()

    def git(self, *args, repo=None):
        return subprocess.check_output(["git", "-C", str(repo or self.repo), *args], stderr=subprocess.DEVNULL).decode().strip()

    def write(self, name, text):
        target = self.repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def configure(self):
        self.config.write_text(json.dumps({"repositories": {str(self.repo): self.policy}}))

    def run_map(self, command, text="", repo=None):
        output = subprocess.check_output(["python3", "-I", str(self.wrapper), command, text,
                                          "--repo", str(repo or self.repo), "--config", str(self.config),
                                          "--cache", str(self.cache)], timeout=60)
        return json.loads(output), output

    def prepare(self, repo=None):
        if not (VENV / "bin/python").exists():
            self.fail("Install Graphify first or set CLI_GRAPHIFY_TEST_VENV to the pinned venv")
        result, _ = self.run_map("prepare", repo=repo)
        self.assertEqual(result["state"], "ready", result)
        return result

    def test_languages_cross_file_evidence_and_no_source_execution(self):
        sentinel = self.root / "EXECUTED"
        self.write("src/evil.py", f"open({str(sentinel)!r}, 'w').write('bad')\n")
        self.commit()
        self.prepare()
        self.assertFalse(sentinel.exists())
        for symbol, file in [("total", "src/maths.py"), ("greet", "src/math.ts"), ("Sample", "src/Sample.java")]:
            result, _ = self.run_map("query", symbol)
            self.assertTrue(any(n["source_file"] == file for n in result["matches"]), result)
        result, _ = self.run_map("query", "total")
        self.assertTrue(any(e["relation"] == "calls" and e["source_file"] == "src/use.py" for e in result["edges"]))
        self.assertTrue(all(e["confidence"] in {"EXTRACTED", "INFERRED"} for e in result["edges"]))
        self.assertIn("runtime", result["caution"])

    def test_missing_disabled_error_and_repository_root(self):
        self.assertEqual(self.run_map("status")[0]["state"], "missing")
        self.policy["enabled"] = False
        self.configure()
        self.assertEqual(self.run_map("prepare")[0]["state"], "disabled")
        self.policy.update(enabled=True, roots=["../"])
        self.configure()
        self.assertEqual(self.run_map("prepare")[0]["state"], "error")
        self.assertEqual(self.run_map("prepare", repo=self.root)[0]["state"], "error")

    def test_edits_deletions_branch_changes_and_worktree_isolation(self):
        first = self.prepare()
        other = self.root / "other"
        self.git("worktree", "add", "-qb", "other", str(other))
        (other / "src/maths.py").write_text("def alternate():\n    return 2\n")
        self.git("add", ".", repo=other)
        self.git("commit", "-qm", "alternate", repo=other)
        second = self.prepare(repo=other)
        self.assertNotEqual(first["identity"], second["identity"])
        self.assertFalse(self.run_map("query", "alternate")[0]["matches"])
        self.assertFalse(self.run_map("query", "total", repo=other)[0]["matches"])
        self.write("src/maths.py", "def changed():\n    return 3\n")
        self.assertEqual(self.run_map("query", "total")[0]["state"], "stale")
        self.prepare()
        (self.repo / "src/maths.py").unlink()
        self.assertEqual(self.run_map("query", "changed")[0]["state"], "stale")
        self.prepare()
        self.assertFalse(self.run_map("query", "changed")[0]["matches"])
        self.git("checkout", "-qb", "newbranch")
        self.assertEqual(self.run_map("status")[0]["state"], "stale")

    def test_exclusions_symlinks_and_explicit_untracked_policy(self):
        for name in ["src/.env.py", "src/secrets/key.py", "src/customer.py", "src/node_modules/dependency.ts",
                     "src/dist/built.js", "src/.jobs/other.py", "src/data/customers.py", "docs/report.py"]:
            self.write(name, "def excluded_symbol():\n    pass\n")
        outside = self.root / "outside.py"
        outside.write_text("def escaped_symbol():\n    pass\n")
        (self.repo / "src/link.py").symlink_to(outside)
        (self.repo / "src/escape").symlink_to(self.root, target_is_directory=True)
        self.commit()
        self.write("src/new.py", "def new_symbol():\n    pass\n")
        self.prepare()
        self.assertFalse(self.run_map("query", "excluded_symbol escaped_symbol new_symbol")[0]["matches"])
        self.policy["includeUntracked"] = True
        self.configure()
        self.assertEqual(self.run_map("status")[0]["state"], "stale")
        self.prepare()
        self.assertTrue(self.run_map("query", "new_symbol")[0]["matches"])
        # Replacing a tracked directory with a symlink cannot expose external bytes.
        shutil.rmtree(self.repo / "src")
        (self.repo / "src").symlink_to(self.root, target_is_directory=True)
        self.prepare()
        self.assertFalse(self.run_map("query", "escaped_symbol")[0]["matches"])

    def test_bounded_queries_parallel_preparation_and_metrics(self):
        for i in range(40):
            self.write(f"src/sample{i}.py", f"def sample_{i}():\n    pass\n")
        self.commit()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.run_map("prepare")[0], range(2)))
        self.assertTrue(any(r["state"] == "ready" for r in results), results)
        self.assertTrue(all(r["state"] in {"ready", "preparing"} for r in results))
        self.prepare()
        self.policy["outputBytes"] = 1800
        self.configure()
        self.prepare()
        result, output = self.run_map("query", "sample")
        self.assertLessEqual(len(output), 1800)
        self.assertTrue(result["truncated"])
        self.assertIn("provenance", result)
        events = [json.loads(line) for path in self.cache.rglob("metrics.jsonl") for line in path.read_text().splitlines()]
        self.assertTrue(any(e["command"] == "query" and e["outputBytes"] <= 1800 for e in events))

    def test_worker_failure_timeout_and_network_guard(self):
        self.prepare()
        adapter = self.installation / "extract.py"
        adapter.write_text("raise RuntimeError('failure')\n")
        self.assertEqual(self.run_map("prepare")[0]["state"], "error")
        self.assertEqual(self.run_map("query", "total")[0]["state"], "error")
        adapter.write_text("import time\ntime.sleep(3)\n")
        self.policy["extractionTimeoutSeconds"] = 1
        self.configure()
        self.assertEqual(self.run_map("prepare")[0]["reason"], "TimeoutExpired")
        # The real adapter audit hook blocks an attempted network operation.
        adapter.write_text((SOURCE / "extract.py").read_text().replace("from graphify.extract import extract", "import socket; socket.socket()\nfrom graphify.extract import extract"))
        self.assertEqual(self.run_map("prepare")[0]["state"], "error")

    def test_interactive_guidance_is_additive_and_refuses_overwrites(self):
        originals = {"AGENTS.md": "Existing agent rules\n", "CLAUDE.md": "Existing Claude rules\n"}
        for name, text in originals.items():
            self.write(name, text)
        for assistant, folder in [("claude", ".claude"), ("codex", ".agents")]:
            command = ["python3", "-I", str(SOURCE / "interactive.py"), "--repo", str(self.repo), "--assistant", assistant]
            subprocess.run(command, check=True, capture_output=True)
            skill = self.repo / folder / "skills/cli-local-project-map/SKILL.md"
            self.assertIn("Skip graph queries for trivial edits", skill.read_text())
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            subprocess.run(command + ["--remove"], check=True, capture_output=True)
            self.assertFalse(skill.exists())
        for name, text in originals.items():
            self.assertEqual((self.repo / name).read_text(), text)


if __name__ == "__main__":
    unittest.main()
