import { describe, expect, it, vi } from 'vitest';
import { CachingEmbeddingProvider } from '../../src/knowledge/embedding-cache.js';
import type { PgPoolLike } from '../../src/knowledge/pg-store.js';
import { embeddingHash } from '../../src/knowledge/embed-text.js';
import { sourceHash } from '../../src/knowledge/hash.js';

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

function cacheFixture(initial: Array<[string, string]> = []) {
  const entries = new Map(initial);
  const leases = new Map<string, string>();
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const hashes = Array.isArray(values[1])
      ? (values[1] as string[])
      : [String(values[1])];
    if (
      sql.includes('SELECT') &&
      sql.includes('FROM project_knowledge.embedding_cache')
    )
      return {
        rows: hashes.flatMap((hash) =>
          entries.has(hash)
            ? [{ text_hash: hash, embedding: entries.get(hash)! }]
            : [],
        ),
      };
    if (
      sql.includes('INSERT INTO project_knowledge.embedding_compute_leases')
    ) {
      return {
        rows: hashes.flatMap((hash) => {
          if (leases.has(hash)) return [];
          leases.set(hash, String(values[2]));
          return [{ text_hash: hash }];
        }),
      };
    }
    if (sql.includes('INSERT INTO project_knowledge.embedding_cache')) {
      hashes.forEach((hash, index) =>
        entries.set(
          hash,
          Array.isArray(values[3])
            ? String(values[3][index])
            : String(values[2]),
        ),
      );
      return { rows: hashes.map((hash) => ({ text_hash: hash })) };
    }
    if (sql.includes('DELETE FROM project_knowledge.embedding_compute_leases'))
      hashes.forEach((hash) => leases.delete(hash));
    return { rows: [] };
  });
  return { pool: fakePool(query), query, entries };
}

describe('CachingEmbeddingProvider', () => {
  it('coalesces simultaneous equal query inputs into one model request', async () => {
    let finish!: (vector: number[]) => void;
    const pending = new Promise<number[]>((resolve) => {
      finish = resolve;
    });
    const inner = { embed: vi.fn(async () => pending) };
    const provider = new CachingEmbeddingProvider(inner, undefined, model);
    const requests = [provider.embed('needle'), provider.embed('needle')];
    finish([1, 0, 0]);
    await expect(Promise.all(requests)).resolves.toEqual([
      [1, 0, 0],
      [1, 0, 0],
    ]);
    expect(inner.embed).toHaveBeenCalledTimes(1);
  });

  it('releases a failed shared query request so the next request can retry', async () => {
    const inner = {
      embed: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue([1, 0, 0]),
    };
    const provider = new CachingEmbeddingProvider(inner, undefined, model);
    const requests = await Promise.allSettled([
      provider.embed('needle'),
      provider.embed('needle'),
    ]);
    expect(requests.map((request) => request.status)).toEqual([
      'rejected',
      'rejected',
    ]);
    await expect(provider.embed('needle')).resolves.toEqual([1, 0, 0]);
    expect(inner.embed).toHaveBeenCalledTimes(2);
  });

  it('keeps different long query inputs separate in the cache', async () => {
    const provider = new CachingEmbeddingProvider(
      {
        embed: async (text) => (text.endsWith('first') ? [1, 0, 0] : [0, 1, 0]),
      },
      undefined,
      model,
    );
    const prefix = 'shared words '.repeat(150);
    await expect(provider.embed(`${prefix}first`)).resolves.toEqual([1, 0, 0]);
    await expect(provider.embed(`${prefix}second`)).resolves.toEqual([0, 1, 0]);
  });

  it('does not reuse document cache entries as query embeddings', async () => {
    const documentHash = embeddingHash(
      'Represent this sentence for searching relevant passages: needle',
    );
    const provider = new CachingEmbeddingProvider(
      { embed: async () => [0, 1, 0] },
      cacheFixture([[documentHash, '[1,0,0]']]).pool,
      model,
    );
    await expect(provider.embed('needle')).resolves.toEqual([0, 1, 0]);
  });

  it('serves an in-memory LRU hit without another database or model call', async () => {
    const { pool, query } = cacheFixture();
    const inner = { embed: vi.fn(async () => [0.1, 0.2, 0.3]) };
    const provider = new CachingEmbeddingProvider(inner, pool, model);

    await provider.embed('needle');
    const databaseCalls = query.mock.calls.length;
    await provider.embed('needle');

    expect(inner.embed).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(databaseCalls);
  });

  it('serves a database hit without calling the model', async () => {
    const { pool } = cacheFixture([
      [
        sourceHash(
          'query\0Represent this sentence for searching relevant passages: needle',
        ),
        '[0.1,0.2,0.3]',
      ],
    ]);
    const inner = { embed: vi.fn(async () => [9, 9, 9]) };
    const provider = new CachingEmbeddingProvider(inner, pool, model);

    await expect(provider.embed('needle')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(inner.embed).not.toHaveBeenCalled();
  });

  it('prefixes a cache miss for the model and stores its vector', async () => {
    const { pool, entries } = cacheFixture();
    const inner = { embed: vi.fn(async () => [0.1, 0.2, 0.3]) };
    const provider = new CachingEmbeddingProvider(inner, pool, model);

    await provider.embed('needle');

    expect(inner.embed).toHaveBeenCalledWith(
      'Represent this sentence for searching relevant passages: needle',
    );
    expect([...entries.values()]).toEqual(['[0.1,0.2,0.3]']);
  });

  it('signals unavailable semantics instead of duplicating work when coordination fails', async () => {
    const query = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    const inner = { embed: vi.fn(async () => [0.1, 0.2, 0.3]) };
    const provider = new CachingEmbeddingProvider(
      inner,
      fakePool(query),
      model,
    );

    await expect(provider.embed('needle')).rejects.toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
    });
    expect(inner.embed).not.toHaveBeenCalled();
  });
});
