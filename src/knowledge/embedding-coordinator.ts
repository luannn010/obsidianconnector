import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { KnowledgeError } from './errors.js';
import type { PgPoolLike } from './pg-store.js';

export interface CoordinatedEmbedding {
  vector: number[];
  computed: boolean;
}

export class PgEmbeddingCoordinator {
  private readonly leaseMs: number;
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly maxComputeMs: number;

  constructor(
    private readonly pool: Pick<PgPoolLike, 'query'>,
    private readonly dimensions: number,
    options?: {
      leaseMs?: number;
      waitMs?: number;
      pollMs?: number;
      maxComputeMs?: number;
    },
  ) {
    this.leaseMs = Math.max(30, options?.leaseMs ?? 30_000);
    this.waitMs = Math.max(1, options?.waitMs ?? 35_000);
    this.pollMs = Math.max(1, options?.pollMs ?? 100);
    this.maxComputeMs = Math.max(1, options?.maxComputeMs ?? 60_000);
  }

  private unavailable(message: string): KnowledgeError {
    return new KnowledgeError('EMBEDDING_UNAVAILABLE', message, true);
  }

  private async read(
    model: string,
    hashes: string[],
    result: Map<string, CoordinatedEmbedding>,
  ): Promise<void> {
    const cached = await this.pool.query<{
      text_hash: string;
      embedding: unknown;
    }>(
      `SELECT text_hash,embedding FROM project_knowledge.embedding_cache
       WHERE model_key=$1 AND text_hash=ANY($2::char(64)[])`,
      [model, hashes],
    );
    for (const row of cached.rows) {
      let vector: unknown = row.embedding;
      if (typeof vector === 'string') {
        try {
          vector = JSON.parse(vector);
        } catch {
          continue;
        }
      }
      if (
        Array.isArray(vector) &&
        vector.length === this.dimensions &&
        vector.every((v) => typeof v === 'number' && Number.isFinite(v))
      )
        result.set(row.text_hash.trim(), { vector, computed: false });
    }
  }

  async getOrCompute(
    model: string,
    hash: string,
    compute: () => Promise<number[]>,
  ): Promise<number[]> {
    return (
      await this.getOrComputeMany(model, [hash], async () => [await compute()])
    ).get(hash)!.vector;
  }

  async getOrComputeMany(
    model: string,
    hashes: string[],
    compute: (hashes: string[]) => Promise<number[][]>,
  ): Promise<Map<string, CoordinatedEmbedding>> {
    const unique = [...new Set(hashes)];
    const result = new Map<string, CoordinatedEmbedding>();
    const owner = randomUUID();
    const deadline = Date.now() + this.waitMs;
    try {
      while (result.size < unique.length) {
        const missing = unique.filter((hash) => !result.has(hash));
        await this.read(model, missing, result);
        const pending = missing.filter((hash) => !result.has(hash));
        if (pending.length === 0) break;
        const claimed = await this.pool.query<{ text_hash: string }>(
          `INSERT INTO project_knowledge.embedding_compute_leases(model_key,text_hash,lease_owner,lease_expires_at)
           SELECT $1,hash,$3::uuid,clock_timestamp()+$4::int*interval '1 millisecond'
           FROM unnest($2::char(64)[]) AS hash ORDER BY hash
           ON CONFLICT(model_key,text_hash) DO UPDATE
             SET lease_owner=EXCLUDED.lease_owner,lease_expires_at=EXCLUDED.lease_expires_at
             WHERE embedding_compute_leases.lease_expires_at<=clock_timestamp()
           RETURNING text_hash`,
          [model, pending, owner, this.leaseMs],
        );
        const owned = claimed.rows.map((row) => row.text_hash.trim());
        if (owned.length) {
          let renewing = false;
          const renewal = setInterval(
            () => {
              if (renewing) return;
              renewing = true;
              void this.pool
                .query(
                  `UPDATE project_knowledge.embedding_compute_leases
               SET lease_expires_at=clock_timestamp()+$4::int*interval '1 millisecond'
               WHERE model_key=$1 AND text_hash=ANY($2::char(64)[]) AND lease_owner=$3::uuid
                 AND lease_expires_at>clock_timestamp()`,
                  [model, owned, owner, this.leaseMs],
                )
                .catch(() => undefined)
                .finally(() => {
                  renewing = false;
                });
            },
            Math.max(10, Math.floor(this.leaseMs / 3)),
          );
          renewal.unref();
          try {
            await this.read(model, owned, result);
            const toCompute = owned.filter((hash) => !result.has(hash));
            if (toCompute.length) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              const vectors = await Promise.race([
                compute(toCompute),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () =>
                      reject(
                        this.unavailable('Embedding computation timed out'),
                      ),
                    this.maxComputeMs,
                  );
                }),
              ]).finally(() => {
                if (timer) clearTimeout(timer);
              });
              if (
                vectors.length !== toCompute.length ||
                vectors.some(
                  (vector) =>
                    vector.length !== this.dimensions ||
                    !vector.every(Number.isFinite),
                )
              )
                throw this.unavailable(
                  'Embedding computation returned invalid vectors',
                );
              const published = await this.pool.query<{ text_hash: string }>(
                `WITH owned AS MATERIALIZED (
                   SELECT text_hash FROM project_knowledge.embedding_compute_leases
                   WHERE model_key=$1 AND text_hash=ANY($2::char(64)[]) AND lease_owner=$3::uuid
                     AND lease_expires_at>clock_timestamp() FOR UPDATE
                 )
                 INSERT INTO project_knowledge.embedding_cache(model_key,text_hash,embedding)
                 SELECT $1,data.text_hash,data.embedding::vector
                 FROM unnest($2::char(64)[],$4::text[]) AS data(text_hash,embedding)
                 JOIN owned USING(text_hash)
                 ON CONFLICT(model_key,text_hash) DO UPDATE SET embedding=EXCLUDED.embedding,last_used_at=now()
                 RETURNING text_hash`,
                [
                  model,
                  toCompute,
                  owner,
                  vectors.map((vector) => JSON.stringify(vector)),
                ],
              );
              for (const { text_hash } of published.rows) {
                const hash = text_hash.trim();
                result.set(hash, {
                  vector: vectors[toCompute.indexOf(hash)]!,
                  computed: true,
                });
              }
            }
          } finally {
            clearInterval(renewal);
            await this.pool
              .query(
                `DELETE FROM project_knowledge.embedding_compute_leases
               WHERE model_key=$1 AND text_hash=ANY($2::char(64)[]) AND lease_owner=$3::uuid`,
                [model, owned, owner],
              )
              .catch(() => undefined);
          }
        }
        if (result.size === unique.length) break;
        if (Date.now() >= deadline)
          throw this.unavailable(
            'Embedding coordination timed out waiting for another worker',
          );
        await delay(Math.min(this.pollMs, Math.max(1, deadline - Date.now())));
      }
      return result;
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw this.unavailable(
        `Embedding coordination unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
