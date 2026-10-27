import { describe, expect, it, vi } from 'vitest';
import { CachingEmbeddingProvider } from '../../src/knowledge/embedding-cache.js';
import type { PgPoolLike } from '../../src/knowledge/pg-store.js';

const model = { name: 'BAAI/bge-small-en-v1.5', revision: 'r1', dimensions: 3 };

function fakePool(
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>,
): PgPoolLike {
  return {
    query: query as PgPoolLike['query'],
    async connect() {
      throw new Error('not used');
    },
  };
}

describe('CachingEmbeddingProvider', () => {
  it('serves an in-memory LRU hit without another database or model call', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const inner = { embed: vi.fn(async () => [0.1, 0.2, 0.3]) };
    const provider = new CachingEmbeddingProvider(
      inner,
      fakePool(query),
      model,
    );

    await provider.embed('needle');
    await provider.embed('needle');

    expect(inner.embed).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('serves a database hit without calling the model', async () => {
    const query = vi.fn(async () => ({
      rows: [{ embedding: '[0.1,0.2,0.3]' }],
    }));
    const inner = { embed: vi.fn(async () => [9, 9, 9]) };
    const provider = new CachingEmbeddingProvider(
      inner,
      fakePool(query),
      model,
    );

    await expect(provider.embed('needle')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(inner.embed).not.toHaveBeenCalled();
  });

  it('prefixes a cache miss for the model and stores its vector', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      return { rows: [] };
    });
    const inner = { embed: vi.fn(async () => [0.1, 0.2, 0.3]) };
    const provider = new CachingEmbeddingProvider(
      inner,
      fakePool(query),
      model,
    );

    await provider.embed('needle');

    expect(inner.embed).toHaveBeenCalledWith(
      'Represent this sentence for searching relevant passages: needle',
    );
    expect(
      statements.some(({ sql }) =>
        sql.includes('INSERT INTO project_knowledge.embedding_cache'),
      ),
    ).toBe(true);
  });

  it('falls through to the model when the database lookup fails', async () => {
    const query = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    const inner = { embed: vi.fn(async () => [0.1, 0.2, 0.3]) };
    const provider = new CachingEmbeddingProvider(
      inner,
      fakePool(query),
      model,
    );

    await expect(provider.embed('needle')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(inner.embed).toHaveBeenCalledTimes(1);
  });
});
