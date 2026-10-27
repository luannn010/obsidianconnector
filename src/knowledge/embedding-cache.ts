import {
  embeddingHash,
  embeddingModelKey,
  queryEmbeddingText,
  type EmbeddingModelKeyInput,
} from './embed-text.js';
import type { EmbeddingProvider, PgPoolLike } from './pg-store.js';

const MEMORY_CACHE_LIMIT = 500;

function parseVector(value: unknown): number[] | undefined {
  if (Array.isArray(value)) {
    const vector = value.map(Number);
    return vector.every(Number.isFinite) ? vector : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined;
  const vector = trimmed
    .slice(1, -1)
    .split(',')
    .filter((entry) => entry.length > 0)
    .map(Number);
  return vector.every(Number.isFinite) ? vector : undefined;
}

export class CachingEmbeddingProvider implements EmbeddingProvider {
  private readonly memory = new Map<string, number[]>();
  private readonly modelKey: string;
  private readonly dimensions: number;

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly pool: PgPoolLike | undefined,
    model: EmbeddingModelKeyInput,
  ) {
    this.modelKey = embeddingModelKey(model);
    this.dimensions = model.dimensions;
  }

  private remember(hash: string, vector: number[]): void {
    this.memory.delete(hash);
    this.memory.set(hash, vector);
    if (this.memory.size > MEMORY_CACHE_LIMIT) {
      const oldest = this.memory.keys().next().value as string | undefined;
      if (oldest) this.memory.delete(oldest);
    }
  }

  async embed(query: string): Promise<number[]> {
    const text = queryEmbeddingText(query);
    const hash = embeddingHash(text);
    const remembered = this.memory.get(hash);
    if (remembered) {
      this.remember(hash, remembered);
      return remembered;
    }

    if (this.pool) {
      try {
        const cached = await this.pool.query<{ embedding: unknown }>(
          `SELECT embedding FROM project_knowledge.embedding_cache
           WHERE model_key=$1 AND text_hash=$2`,
          [this.modelKey, hash],
        );
        const vector = parseVector(cached.rows[0]?.embedding);
        if (vector?.length === this.dimensions) {
          await this.pool
            .query(
              `UPDATE project_knowledge.embedding_cache
               SET last_used_at=now() WHERE model_key=$1 AND text_hash=$2`,
              [this.modelKey, hash],
            )
            .catch(() => undefined);
          this.remember(hash, vector);
          return vector;
        }
      } catch {
        // Cache availability must not make semantic search unavailable.
      }
    }

    const vector = await this.inner.embed(text);
    this.remember(hash, vector);
    if (this.pool) {
      await this.pool
        .query(
          `INSERT INTO project_knowledge.embedding_cache(model_key,text_hash,embedding)
           VALUES($1,$2,$3::vector) ON CONFLICT(model_key,text_hash) DO NOTHING`,
          [this.modelKey, hash, `[${vector.join(',')}]`],
        )
        .catch(() => undefined);
    }
    return vector;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (this.inner.embedMany) return this.inner.embedMany(texts);
    return Promise.all(texts.map((text) => this.inner.embed(text)));
  }
}
