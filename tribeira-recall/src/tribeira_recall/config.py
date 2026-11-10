from __future__ import annotations

import os
from pathlib import Path

APP_NAME = "tribeira-recall"
DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
EMBEDDING_DIMENSIONS = 384


def database_path() -> Path:
    return Path(os.environ.get("RECALL_DB", "~/.local/share/tribeira/recall.db")).expanduser()


def artifact_root() -> Path:
    return Path(os.environ.get("RECALL_ARTIFACT_ROOT", "~/.local/share/tribeira/artifacts")).expanduser()


def model_cache() -> Path:
    return Path(os.environ.get("FASTEMBED_CACHE_PATH", "~/.cache/tribeira/fastembed")).expanduser()


def owner_name() -> str:
    return os.environ.get("RECALL_OWNER", "opencode")
