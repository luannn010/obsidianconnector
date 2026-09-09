import { KnowledgeError } from './errors.js';
import type { EmbeddingProvider, Reranker } from './pg-store.js';
import type { ContextHit } from './types.js';

export class OpenAiCompatibleEmbeddingClient implements EmbeddingProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly dimensions: number,
    private readonly token?: string,
  ) {}

  async embed(text: string): Promise<number[]> {
    const response = await fetch(new URL('/v1/embeddings', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: [text] }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
    if (!response?.ok)
      throw new KnowledgeError(
        'EMBEDDING_UNAVAILABLE',
        'Local embedding service is unavailable',
        true,
      );
    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const vector = payload.data?.[0]?.embedding;
    if (!vector || vector.length !== this.dimensions) {
      throw new KnowledgeError(
        'EMBEDDING_UNAVAILABLE',
        'Local embedding model returned an incompatible dimension',
        false,
        {
          expectedDimensions: this.dimensions,
          actualDimensions: vector?.length ?? 0,
        },
      );
    }
    return vector;
  }
}

export class HttpCrossEncoderReranker implements Reranker {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly token?: string,
  ) {}
  async rerank(query: string, hits: ContextHit[]): Promise<ContextHit[]> {
    const response = await fetch(new URL('/v1/rerank', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: hits.map((hit) => ({ id: hit.ref, text: hit.excerpt })),
      }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => undefined);
    if (!response?.ok) return hits;
    const payload = (await response.json()) as {
      results?: Array<{ id: string; score: number }>;
    };
    if (!payload.results) return hits;
    const hitsById = new Map(hits.map((hit) => [hit.ref, hit]));
    return payload.results
      .map((result) => hitsById.get(result.id))
      .filter((hit): hit is ContextHit => Boolean(hit));
  }
}
