from __future__ import annotations

import unittest

from tribeira_recall.config import EMBEDDING_DIMENSIONS
from tribeira_recall.embeddings import LocalEmbedder


class FakeVector:
    def __init__(self, values):
        self._values = values

    @property
    def values(self):
        return self._values

    def tolist(self):
        return self._values


_Vector = FakeVector


class FakeModel:
    def __init__(self, dimensions=EMBEDDING_DIMENSIONS):
        self.dimensions = dimensions
        self.embed_calls = 0
        self.query_calls = 0
        self.embedded = []
        self.queried = []

    def embed(self, texts):
        self.embed_calls += 1
        self.embedded.extend(texts)
        return [FakeVector([0.1] * self.dimensions) for _ in texts]

    def query_embed(self, text):
        self.query_calls += 1
        self.queried.append(text)
        return iter([FakeVector([0.2] * self.dimensions)])


_FakeModel = FakeModel


class LocalEmbedderTests(unittest.TestCase):
    def test_empty_embed_does_not_load_model(self):
        embedder = LocalEmbedder()
        self.assertEqual(embedder.embed([]), [])
        self.assertIsNone(embedder._model)

    def test_embed_and_query_validate_dimensions(self):
        embedder = LocalEmbedder()
        model = FakeModel()
        embedder._model = model
        vectors = embedder.embed(["alpha", "beta"])
        self.assertEqual(len(vectors), 2)
        self.assertEqual(len(vectors[0]), EMBEDDING_DIMENSIONS)
        self.assertEqual(model.embed_calls, 1)
        query = embedder.query("alpha")
        self.assertEqual(len(query), EMBEDDING_DIMENSIONS)
        self.assertEqual(model.query_calls, 1)
        self.assertGreaterEqual(embedder.last_query_ms, 0.0)

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

    def test_wrong_dimension_is_rejected(self):
        embedder = LocalEmbedder()
        embedder._model = FakeModel(dimensions=EMBEDDING_DIMENSIONS - 1)
        with self.assertRaisesRegex(ValueError, "Expected 384 embedding dimensions"):
            embedder.embed(["alpha"])
        with self.assertRaisesRegex(ValueError, "Expected 384 embedding dimensions"):
            embedder.query("alpha")

    def test_wrong_dimensions_are_rejected(self):
        embedder = LocalEmbedder()
        embedder._model = _FakeModel(dimensions=3)
        with self.assertRaisesRegex(ValueError, "Expected 384 embedding dimensions"):
            embedder.embed(["bad"])
        with self.assertRaisesRegex(ValueError, "Expected 384 embedding dimensions"):
            embedder.query("bad")


if __name__ == "__main__":
    unittest.main()
