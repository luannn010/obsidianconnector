import { describe, expect, it } from 'vitest';
import { PgEmbeddingCoordinator } from '../../src/knowledge/embedding-coordinator.js';
import type { PgPoolLike } from '../../src/knowledge/pg-store.js';

function database() {
  const cache = new Map<string, number[]>();
  const leases = new Map<string, string>();
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      const [model, hashes, owner] = values as [string, string[], string];
      const key = (hash: string) => `${model}:${hash}`;
      if (sql.includes('SELECT text_hash,embedding'))
        return {
          rows: hashes
            .filter((h) => cache.has(key(h)))
            .map((h) => ({ text_hash: h, embedding: cache.get(key(h)) })),
        };
      if (
        sql.includes('INSERT INTO project_knowledge.embedding_compute_leases')
      ) {
        const claimed = hashes.filter((h) => !leases.has(key(h)));
        claimed.forEach((h) => leases.set(key(h), owner));
        return { rows: claimed.map((text_hash) => ({ text_hash })) };
      }
      if (sql.includes('INSERT INTO project_knowledge.embedding_cache')) {
        const vectors = values[3] as string[];
        const published = hashes.filter((h) => leases.get(key(h)) === owner);
        published.forEach((h) =>
          cache.set(key(h), JSON.parse(vectors[hashes.indexOf(h)]!)),
        );
        return { rows: published.map((text_hash) => ({ text_hash })) };
      }
      if (
        sql.includes('DELETE FROM project_knowledge.embedding_compute_leases')
      ) {
        hashes.forEach((h) => {
          if (leases.get(key(h)) === owner) leases.delete(key(h));
        });
      }
      return { rows: [] };
    },
  } as unknown as PgPoolLike;
  return { pool, cache, leases };
}

describe('PgEmbeddingCoordinator', () => {
  it('coalesces identical inputs across coordinator instances while retaining batches', async () => {
    const { pool } = database();
    const one = new PgEmbeddingCoordinator(pool, 2, { pollMs: 1 });
    const two = new PgEmbeddingCoordinator(pool, 2, { pollMs: 1 });
    let calls = 0;
    const compute = async (hashes: string[]) => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return hashes.map(() => [1, 2]);
    };
    const [a, b] = await Promise.all([
      one.getOrComputeMany('m', ['a', 'b'], compute),
      two.getOrComputeMany('m', ['a', 'b'], compute),
    ]);
    expect(calls).toBe(1);
    expect(a.get('b')?.vector).toEqual([1, 2]);
    expect(b.get('a')?.vector).toEqual([1, 2]);
  });

  it('releases failed computation so the next caller can retry', async () => {
    const { pool, leases } = database();
    const coordinator = new PgEmbeddingCoordinator(pool, 2);
    await expect(
      coordinator.getOrCompute('m', 'a', async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow();
    expect(leases.size).toBe(0);
    await expect(
      coordinator.getOrCompute('m', 'a', async () => [3, 4]),
    ).resolves.toEqual([3, 4]);
  });

  it('bounds contention without starting duplicate inference', async () => {
    const { pool, leases } = database();
    leases.set('m:a', 'other');
    const coordinator = new PgEmbeddingCoordinator(pool, 2, {
      waitMs: 5,
      pollMs: 1,
    });
    let called = false;
    await expect(
      coordinator.getOrCompute('m', 'a', async () => {
        called = true;
        return [1, 2];
      }),
    ).rejects.toThrow(/timed out/i);
    expect(called).toBe(false);
  });

  it('rejects invalid vectors without poisoning the cache', async () => {
    const { pool, cache } = database();
    const coordinator = new PgEmbeddingCoordinator(pool, 2);
    await expect(
      coordinator.getOrCompute('m', 'a', async () => [NaN, 1]),
    ).rejects.toThrow();
    expect(cache.size).toBe(0);
  });
});
