import os
import secrets
from threading import Condition
from contextlib import contextmanager
from time import monotonic
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import CrossEncoder, SentenceTransformer


def bounded_integer(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return min(maximum, max(minimum, value))


EMBED_MODEL = os.getenv(
    "RETRIEVAL_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5"
).strip()
EMBED_DIMENSIONS = bounded_integer("RETRIEVAL_EMBEDDING_DIMENSIONS", 384, 1, 4096)
RERANK_MODEL = os.getenv(
    "RETRIEVAL_RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2"
).strip()
BEARER_TOKEN = os.getenv("RETRIEVAL_MODEL_BEARER_TOKEN", "").strip()
MAX_CONCURRENCY = bounded_integer("RETRIEVAL_MODEL_MAX_CONCURRENCY", 2, 1, 8)
MAX_BACKGROUND = min(
    max(1, MAX_CONCURRENCY - 1),
    bounded_integer("RETRIEVAL_MODEL_MAX_BACKGROUND", 1, 1, 8),
)


class ModelCapacity:
    def __init__(self, total: int, background: int):
        self.total = total
        self.background = min(max(1, total - 1), background)
        self.active = 0
        self.active_background = 0
        self.waiting_interactive = 0
        self.condition = Condition()

    @contextmanager
    def slot(self, priority: str):
        interactive = priority == "interactive"
        deadline = monotonic() + 25
        with self.condition:
            if interactive:
                self.waiting_interactive += 1
            try:
                while self.active >= self.total or (
                    not interactive and (
                        self.active_background >= self.background or self.waiting_interactive > 0
                    )
                ):
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        raise HTTPException(status_code=503, detail="Model capacity is busy")
                    self.condition.wait(remaining)
                self.active += 1
                if not interactive:
                    self.active_background += 1
            finally:
                if interactive:
                    self.waiting_interactive -= 1
                    self.condition.notify_all()
        try:
            yield
        finally:
            with self.condition:
                self.active -= 1
                if not interactive:
                    self.active_background -= 1
                self.condition.notify_all()

app = FastAPI()
embedder = SentenceTransformer(EMBED_MODEL)
reranker = None
model_slots = ModelCapacity(MAX_CONCURRENCY, MAX_BACKGROUND)


class EmbeddingRequest(BaseModel):
    input: str | list[str]
    model: str = EMBED_MODEL
    priority: Literal["interactive", "background"] = "background"


class RerankDocument(BaseModel):
    id: str
    text: str


class RerankRequest(BaseModel):
    query: str
    documents: list[RerankDocument] = Field(max_length=30)
    model: str = RERANK_MODEL


def require_bearer(authorization: str | None = Header(default=None)) -> None:
    expected = f"Bearer {BEARER_TOKEN}"
    if not BEARER_TOKEN or not authorization or not secrets.compare_digest(
        authorization, expected
    ):
        raise HTTPException(
            status_code=401,
            detail="Unauthorized",
            headers={"WWW-Authenticate": "Bearer"},
        )


@app.get("/health")
def health():
    return {
        "embedding_model": EMBED_MODEL,
        "dimensions": EMBED_DIMENSIONS,
        "reranker_model": RERANK_MODEL,
        "max_concurrency": MAX_CONCURRENCY,
        "max_background": MAX_BACKGROUND,
        "authentication": "bearer",
    }


@app.post("/v1/embeddings", dependencies=[Depends(require_bearer)])
def embeddings(request: EmbeddingRequest):
    texts = [request.input] if isinstance(request.input, str) else request.input
    with model_slots.slot(request.priority):
        vectors = embedder.encode(texts, normalize_embeddings=True).tolist()
    return {
        "model": EMBED_MODEL,
        "data": [
            {"index": index, "embedding": vector}
            for index, vector in enumerate(vectors)
        ],
    }


@app.post("/v1/rerank", dependencies=[Depends(require_bearer)])
def rerank(request: RerankRequest):
    global reranker
    with model_slots.slot("interactive"):
        if reranker is None:
            reranker = CrossEncoder(RERANK_MODEL)
        scores = reranker.predict(
            [(request.query, document.text) for document in request.documents]
        ).tolist()
    return {
        "results": [
            {"id": request.documents[index].id, "score": float(score)}
            for index, score in sorted(
                enumerate(scores), key=lambda item: item[1], reverse=True
            )
        ]
    }
