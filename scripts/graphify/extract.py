"""Version-specific, code-only Graphify adapter. Run in the isolated venv with -I."""
import importlib.metadata
import json
from pathlib import Path
import resource
import sys


def deny_external(event, args):
    if event.startswith("socket.") or event in {"subprocess.Popen", "os.system", "os.posix_spawn", "os.fork", "os.exec"}:
        raise RuntimeError("Network and subprocesses are disabled during code extraction")


# Defense in depth: this adapter never imports the semantic, CLI, or installer APIs.
sys.addaudithook(deny_external)
resource.setrlimit(resource.RLIMIT_FSIZE, (64_000_000, 64_000_000))
resource.setrlimit(resource.RLIMIT_AS, (1_500_000_000, 1_500_000_000))
if importlib.metadata.version("graphifyy") != "0.9.95":
    raise RuntimeError("Expected Graphify 0.9.95")

from graphify.extract import extract  # noqa: E402

root = Path(sys.argv[1]).resolve()
files = sorted(p for p in root.rglob("*") if p.is_file())
result = extract(files, root=root, cache_root=root, parallel=False)
if result.get("failed_sources"):
    raise RuntimeError("Graphify could not parse all selected files")
# Keep only locations in the safe snapshot, with relative paths for portability.
for node in result["nodes"]:
    for field in ("source_file", "definition_file"):
        value = node.get(field)
        if value:
            path = Path(value)
            if path.is_absolute():
                path = path.relative_to(root)
            if ".." in path.parts or not (root / path).is_file():
                node[field] = None
            else:
                node[field] = path.as_posix()
Path(sys.argv[2]).write_text(json.dumps({"nodes": result["nodes"], "edges": result["edges"]}))
