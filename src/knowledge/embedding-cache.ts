import {
  embeddingModelKey,
  queryEmbeddingText,
  type EmbeddingModelKeyInput,
} from './embed-text.js';
import { sourceHash } from './hash.js';
import { PgEmbeddingCoordinator } from './embedding-coordinator.js';
import type { EmbeddingProvider, PgPoolLike } from './pg-store.js';

const MEMORY_CACHE_LIMIT = 500;

export class CachingEmbeddingProvider implements EmbeddingProvider {
  private readonly memory = new Map<string, number[]>();
  private readonly inFlight = new Map<string, Promise<number[]>>();
  private readonly modelKey: string;
  private readonly coordinator: PgEmbeddingCoordinator | undefined;

  constructor(
    private readonly inner: EmbeddingProvider,
    pool: PgPoolLike | undefined,
    model: EmbeddingModelKeyInput,
  ) {
    this.modelKey = embeddingModelKey(model);
    this.coordinator = pool
      ? new PgEmbeddingCoordinator(pool, model.dimensions)
      : undefined;
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
    // Query inputs are not document snippets: hash the complete model input
    // and isolate it from the shared document-embedding cache namespace.
    const hash = sourceHash(`query\0${text}`);
    const remembered = this.memory.get(hash);
    if (remembered) {
      this.remember(hash, remembered);
      return remembered;
    }
    const pending = this.inFlight.get(hash);
    if (pending) return pending;
    const computation = this.compute(text, hash).finally(() => {
      this.inFlight.delete(hash);
    });
    this.inFlight.set(hash, computation);
    return computation;
  }

  private async compute(text: string, hash: string): Promise<number[]> {
    const vector = this.coordinator
      ? await this.coordinator.getOrCompute(this.modelKey, hash, () =>
          this.inner.embed(text),
        )
      : await this.inner.embed(text);
    this.remember(hash, vector);
    return vector;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (this.inner.embedMany) return this.inner.embedMany(texts);
    return Promise.all(texts.map((text) => this.inner.embed(text)));
  }
}
