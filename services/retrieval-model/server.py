import os
import secrets
from threading import BoundedSemaphore

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

app = FastAPI()
embedder = SentenceTransformer(EMBED_MODEL)
reranker = None
model_slots = BoundedSemaphore(MAX_CONCURRENCY)


class EmbeddingRequest(BaseModel):
    input: str | list[str]
    model: str = EMBED_MODEL


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
        "authentication": "bearer",
    }


@app.post("/v1/embeddings", dependencies=[Depends(require_bearer)])
def embeddings(request: EmbeddingRequest):
    texts = [request.input] if isinstance(request.input, str) else request.input
    with model_slots:
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
    with model_slots:
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
