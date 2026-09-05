from fastapi import FastAPI
from pydantic import BaseModel, Field
from sentence_transformers import CrossEncoder, SentenceTransformer

EMBED_MODEL = "BAAI/bge-large-en-v1.5"
RERANK_MODEL = "BAAI/bge-reranker-base"
app = FastAPI()
embedder = SentenceTransformer(EMBED_MODEL)
reranker = None

class EmbeddingRequest(BaseModel):
    input: str | list[str]
    model: str = EMBED_MODEL

class RerankRequest(BaseModel):
    query: str
    documents: list[str] = Field(max_length=30)

@app.get("/health")
def health():
    return {"embedding_model": EMBED_MODEL, "dimensions": 1024, "reranker_model": RERANK_MODEL}

@app.post("/v1/embeddings")
def embeddings(request: EmbeddingRequest):
    texts = [request.input] if isinstance(request.input, str) else request.input
    vectors = embedder.encode(texts, normalize_embeddings=True).tolist()
    return {"model": EMBED_MODEL, "data": [{"index": index, "embedding": vector} for index, vector in enumerate(vectors)]}

@app.post("/rerank")
def rerank(request: RerankRequest):
    global reranker
    if reranker is None:
        reranker = CrossEncoder(RERANK_MODEL)
    scores = reranker.predict([(request.query, document) for document in request.documents]).tolist()
    return {"results": [{"index": index, "score": score} for index, score in sorted(enumerate(scores), key=lambda item: item[1], reverse=True)]}
