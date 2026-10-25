#!/usr/bin/env python3
"""Install only this integration into a private, versioned directory. No assistant installer."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--prefix", type=Path, default=Path.home() / ".local/share/cli-graphify")
args = parser.parse_args()
if sys.version_info[:2] != (3, 12) or sys.platform != "linux" or os.uname().machine != "x86_64":
    raise SystemExit("This pilot lock supports CPython 3.12 / Linux x86_64 only")
source = Path(__file__).resolve().parent
names = ["project-map.py", "extract.py", "requirements.lock"]
identity = hashlib.sha256(b"".join((source / n).read_bytes() for n in names)).hexdigest()[:20]
prefix = args.prefix.resolve()
prefix.mkdir(parents=True, exist_ok=True, mode=0o700)
current = prefix / "current"
if current.exists() and not current.is_symlink():
    raise SystemExit("Refusing to replace an unrelated current directory")
release = prefix / identity
if not release.exists():
    with tempfile.TemporaryDirectory(prefix="setup-", dir=prefix) as tmp:
        staged = Path(tmp) / "release"
        staged.mkdir()
        for name in names:
            shutil.copyfile(source / name, staged / name)
        subprocess.run([sys.executable, "-I", "-m", "venv", str(staged / "venv")], check=True)
        subprocess.run([str(staged / "venv/bin/python"), "-m", "pip", "install", "--require-hashes",
                        "--only-binary=:all:", "-r", str(staged / "requirements.lock")], check=True)
        # The runtime invokes venv/bin/python directly; no moved console-script shebangs are used.
        os.rename(staged, release)
with tempfile.TemporaryDirectory(prefix="activate-", dir=prefix) as tmp:
    link = Path(tmp) / "current"
    link.symlink_to(release, target_is_directory=True)
    os.replace(link, current)
print(f"Installed: python3 -I {current / 'project-map.py'} status --repo /path/to/repository")
