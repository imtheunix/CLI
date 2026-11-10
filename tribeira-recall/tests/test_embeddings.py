from __future__ import annotations

import unittest

from tribeira_recall.embeddings import LocalEmbedder


class _Vector:
    def __init__(self, values):
        self.values = values

    def tolist(self):
        return self.values


class _FakeModel:
    def __init__(self, dimensions=384):
        self.dimensions = dimensions
        self.embedded = []
        self.queried = []

    def embed(self, texts):
        self.embedded.extend(texts)
        return [_Vector([0.0] * self.dimensions) for _ in texts]

    def query_embed(self, text):
        self.queried.append(text)
        return iter([_Vector([0.0] * self.dimensions)])


class LocalEmbedderTests(unittest.TestCase):
    def test_embed_and_query_use_injected_model(self):
        embedder = LocalEmbedder()
        model = _FakeModel()
        embedder._model = model
        self.assertEqual(embedder.embed([]), [])
        self.assertEqual(model.embedded, [])
        vectors = embedder.embed(["one", "two"])
        self.assertEqual(len(vectors), 2)
        self.assertEqual(len(vectors[0]), 384)
        self.assertEqual(model.embedded, ["one", "two"])
        self.assertEqual(len(embedder.query("three")), 384)
        self.assertEqual(model.queried, ["three"])
        self.assertGreaterEqual(embedder.last_query_ms, 0.0)

    def test_wrong_dimensions_are_rejected(self):
        embedder = LocalEmbedder()
        embedder._model = _FakeModel(dimensions=3)
        with self.assertRaisesRegex(ValueError, "Expected 384 embedding dimensions"):
            embedder.embed(["bad"])
        with self.assertRaisesRegex(ValueError, "Expected 384 embedding dimensions"):
            embedder.query("bad")


if __name__ == "__main__":
    unittest.main()
