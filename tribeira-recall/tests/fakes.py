from __future__ import annotations

import hashlib


class FakeEmbedder:
    def __init__(self):
        self.calls = 0
        self.last_query_ms = 0.1
        self.fail = False

    def _vector(self, text: str) -> list[float]:
        vector = [0.0] * 384
        for word in text.lower().split():
            digest = hashlib.sha256(word.encode()).digest()
            vector[digest[0]] += 1.0 if digest[1] % 2 else -1.0
        norm = sum(value * value for value in vector) ** 0.5 or 1.0
        return [value / norm for value in vector]

    def embed(self, texts):
        self.calls += 1
        if self.fail:
            raise RuntimeError("injected embedding failure")
        return [self._vector(text) for text in texts]

    def query(self, text: str):
        return self._vector(text)
