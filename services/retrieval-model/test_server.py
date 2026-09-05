import importlib.util
import os
import sys
import threading
import time
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient


class Values:
    def __init__(self, values):
        self.values = values

    def tolist(self):
        return self.values


class FakeSentenceTransformer:
    active = 0
    max_active = 0
    lock = threading.Lock()

    def __init__(self, model):
        self.model = model

    def encode(self, texts, normalize_embeddings=True):
        with self.lock:
            type(self).active += 1
            type(self).max_active = max(type(self).max_active, type(self).active)
        time.sleep(0.04)
        with self.lock:
            type(self).active -= 1
        return Values([[0.1] * 384 for _ in texts])


class FakeCrossEncoder:
    def __init__(self, model):
        self.model = model

    def predict(self, pairs):
        return Values([float(index) for index, _pair in enumerate(pairs)])


fake_models = types.ModuleType("sentence_transformers")
fake_models.SentenceTransformer = FakeSentenceTransformer
fake_models.CrossEncoder = FakeCrossEncoder
sys.modules["sentence_transformers"] = fake_models
os.environ["RETRIEVAL_MODEL_BEARER_TOKEN"] = "test-secret"
os.environ["RETRIEVAL_MODEL_MAX_CONCURRENCY"] = "1"

spec = importlib.util.spec_from_file_location(
    "retrieval_model_server", Path(__file__).with_name("server.py")
)
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)


class RetrievalModelServerTest(unittest.TestCase):
    def setUp(self):
        FakeSentenceTransformer.active = 0
        FakeSentenceTransformer.max_active = 0
        self.client = TestClient(server.app)

    def test_health_reports_compact_embedding_contract(self):
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["embedding_model"], "BAAI/bge-small-en-v1.5")
        self.assertEqual(response.json()["dimensions"], 384)
        self.assertEqual(
            response.json()["reranker_model"],
            "cross-encoder/ms-marco-MiniLM-L-6-v2",
        )

    def test_model_routes_require_bearer_authentication(self):
        embedding = self.client.post("/v1/embeddings", json={"input": "hello"})
        rerank = self.client.post(
            "/v1/rerank",
            json={
                "query": "hello",
                "documents": [{"id": "document-1", "text": "world"}],
            },
        )

        self.assertEqual(embedding.status_code, 401)
        self.assertEqual(rerank.status_code, 401)

    def test_reranking_returns_stable_document_ids(self):
        response = self.client.post(
            "/v1/rerank",
            headers={"Authorization": "Bearer test-secret"},
            json={
                "query": "allocation ownership",
                "documents": [
                    {"id": "chunk:one", "text": "first"},
                    {"id": "chunk:two", "text": "second"},
                ],
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["results"],
            [
                {"id": "chunk:two", "score": 1.0},
                {"id": "chunk:one", "score": 0.0},
            ],
        )

    def test_embedding_concurrency_is_bounded(self):
        def request_embedding(_index):
            return self.client.post(
                "/v1/embeddings",
                headers={"Authorization": "Bearer test-secret"},
                json={"input": "hello"},
            )

        with ThreadPoolExecutor(max_workers=4) as executor:
            responses = list(executor.map(request_embedding, range(4)))

        self.assertTrue(all(response.status_code == 200 for response in responses))
        self.assertEqual(FakeSentenceTransformer.max_active, 1)


if __name__ == "__main__":
    unittest.main()
