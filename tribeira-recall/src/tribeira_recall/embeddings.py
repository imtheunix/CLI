from __future__ import annotations

import os
from typing import Protocol, Sequence

from .config import DEFAULT_MODEL, EMBEDDING_DIMENSIONS, model_cache


class Embedder(Protocol):
    def embed(self, texts: Sequence[str]) -> list[list[float]]: ...

    def query(self, text: str) -> list[float]: ...


class LocalEmbedder:
    """MiniLM ONNX inference on CPU; only the initial model download uses the network."""

    def __init__(self) -> None:
        self._model = None
        self.last_query_ms = 0.0

    def _get_model(self):
        if self._model is None:
            from fastembed import TextEmbedding

            cache = model_cache()
            cache.mkdir(parents=True, exist_ok=True)
            self._model = TextEmbedding(
                model_name=DEFAULT_MODEL,
                cache_dir=str(cache),
                providers=["CPUExecutionProvider"],
                threads=int(os.environ.get("RECALL_ONNX_THREADS", str(min(8, os.cpu_count() or 1)))),
                lazy_load=True,
            )
        return self._model

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        vectors = list(self._get_model().embed(list(texts)))
        return [_validated(vector.tolist()) for vector in vectors]

    def query(self, text: str) -> list[float]:
        import time

        started = time.perf_counter()
        vector = next(iter(self._get_model().query_embed(text)))
        self.last_query_ms = (time.perf_counter() - started) * 1000
        return _validated(vector.tolist())


def _validated(vector: list[float]) -> list[float]:
    if len(vector) != EMBEDDING_DIMENSIONS:
        raise ValueError(f"Expected {EMBEDDING_DIMENSIONS} embedding dimensions, got {len(vector)}")
    return vector
