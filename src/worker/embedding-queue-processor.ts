import type { Pool, PoolClient } from 'pg';
import {
  EMBEDDABLE_CHUNK_KINDS,
  embeddingHash,
  embeddingModelKey,
  embeddingText,
} from '../knowledge/embed-text.js';
import type { EmbeddingProvider } from '../knowledge/pg-store.js';
import { PgEmbeddingCoordinator } from '../knowledge/embedding-coordinator.js';
import { claimMaintenanceWindow } from './maintenance-window.js';

export interface EmbeddingModelIdentity {
  name: string;
  revision: string;
  dimensions: number;
}

export interface EmbeddingBatchStats {
  claimed: number;
  embedded: number;
  applied: number;
  reused: number;
  cacheHits: number;
  reenqueued: number;
  retired: number;
  completed: number;
  failed: number;
}

interface ClaimedJob {
  id: string;
  chunk_id: string;
  project_id: string;
  content: string;
  content_hash: string;
  embed_hash: string | null;
  attempts: number;
}

interface PreparedJob extends ClaimedJob {
  cacheKey: string;
  embeddingContent: string;
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class EmbeddingQueueProcessor {
  private readonly modelIds = new Map<string, string>();
  private readonly modelKey: string;
  private readonly orphanRepairIntervalMs: number;
  private readonly now: () => number;
  private lastOrphanRepairAt: number | undefined;
  private readonly workerId: string;

  constructor(
    private readonly pool: Pool,
    private readonly embedder: EmbeddingProvider,
    private readonly model: EmbeddingModelIdentity,
    options?: {
      orphanRepairIntervalMs?: number;
      now?: () => number;
      workerId?: string;
    },
  ) {
    this.modelKey = embeddingModelKey(model);
    this.orphanRepairIntervalMs =
      options?.orphanRepairIntervalMs ?? 10 * 60 * 1_000;
    this.now = options?.now ?? Date.now;
    this.workerId = options?.workerId ?? `embedding-${process.pid}`;
  }

  private async sweep(
    client: PoolClient,
    limit: number,
  ): Promise<
    Omit<
      EmbeddingBatchStats,
      'claimed' | 'embedded' | 'applied' | 'failed' | 'reenqueued'
    >
  > {
    const row = (
      await client.query<{
        retired_superseded: number;
        retired_missing: number;
        retired_inactive: number;
        completed: number;
        cache_hits: number;
      }>(
        `WITH live AS MATERIALIZED (
           SELECT j.id,j.project_id,j.payload->>'chunkId' AS chunk_id
           FROM project_knowledge.outbox_jobs j
           WHERE j.job_type='embed_chunk'
             AND (j.state IN ('pending','failed') OR
                  (j.state='processing' AND (j.lease_expires_at IS NULL OR j.lease_expires_at<now())))
           ORDER BY j.priority DESC, j.created_at LIMIT $5 FOR UPDATE OF j SKIP LOCKED
         ), retired_missing AS (
           UPDATE project_knowledge.outbox_jobs j
           SET state='superseded',finished_at=now(),locked_at=NULL,last_error=NULL,
               lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=now(),
               resolution=jsonb_build_object('reason','missing_chunk')
           FROM live l
           WHERE j.id=l.id AND NOT EXISTS (
             SELECT 1 FROM project_knowledge.search_chunks c WHERE c.id=l.chunk_id::uuid
           ) RETURNING j.id
         ), retired_inactive AS (
           UPDATE project_knowledge.outbox_jobs j
           SET state='superseded',finished_at=now(),locked_at=NULL,last_error=NULL,
               lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=now(),
               resolution=jsonb_build_object('reason','inactive_chunk')
           FROM live l JOIN project_knowledge.search_chunks c ON c.id=l.chunk_id::uuid
           WHERE j.id=l.id AND NOT c.active RETURNING j.id
         ), retired_superseded AS (
           UPDATE project_knowledge.outbox_jobs j
           SET state='superseded',finished_at=now(),locked_at=NULL,last_error=NULL,
               lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=now(),
               resolution=jsonb_build_object('reason','superseded_snapshot')
           FROM live l JOIN project_knowledge.search_chunks c ON c.id=l.chunk_id::uuid
           JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
           WHERE j.id=l.id AND c.active AND s.state<>'active' RETURNING j.id
         ), completed AS (
           UPDATE project_knowledge.outbox_jobs j
           SET state='done',finished_at=now(),locked_at=NULL,last_error=NULL,
               lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=now(),
               resolution=jsonb_build_object('reason','already_embedded')
           FROM live l JOIN project_knowledge.search_chunks c ON c.id=l.chunk_id::uuid
           LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
           WHERE j.id=l.id AND c.active AND c.embedding IS NOT NULL
             AND (c.snapshot_id IS NULL OR s.state='active') RETURNING j.id
         ), cache_candidates AS MATERIALIZED (
           SELECT DISTINCT target.id,target.project_id,cache.text_hash,cache.embedding
           FROM live l
           JOIN project_knowledge.search_chunks target ON target.id=l.chunk_id::uuid
           LEFT JOIN project_knowledge.source_snapshots target_snapshot ON target_snapshot.id=target.snapshot_id
           JOIN project_knowledge.embedding_cache cache
             ON cache.model_key=$4 AND cache.text_hash=target.embed_hash
           WHERE target.active AND target.embedding IS NULL
             AND (target.snapshot_id IS NULL OR target_snapshot.state='active')
         ), model_rows AS (
           INSERT INTO project_knowledge.embedding_models
             (project_id,model_name,model_revision,dimensions,active)
           SELECT DISTINCT project_id,$1::text,$2::text,$3::int,true FROM cache_candidates
           ON CONFLICT(project_id,model_name,model_revision)
           DO UPDATE SET dimensions=EXCLUDED.dimensions,active=true
           RETURNING id,project_id
         ), cached_chunks AS (
           UPDATE project_knowledge.search_chunks target
           SET embedding=candidate.embedding,embedding_model_id=model.id
           FROM cache_candidates candidate
           JOIN model_rows model ON model.project_id=candidate.project_id
           WHERE target.id=candidate.id AND target.embedding IS NULL AND target.active
             AND target.embed_hash= candidate.text_hash RETURNING target.id,candidate.text_hash
         ), cached_jobs AS (
           UPDATE project_knowledge.outbox_jobs j
           SET state='done',finished_at=now(),locked_at=NULL,last_error=NULL,
               lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=now(),
               resolution=jsonb_build_object('reason','cache_hit')
           FROM cached_chunks chunk
           WHERE j.id IN (SELECT id FROM live)
             AND j.job_type='embed_chunk' AND j.state IN ('pending','failed','processing')
             AND j.payload->>'chunkId'=chunk.id::text RETURNING j.id
         ), touched_cache AS (
           UPDATE project_knowledge.embedding_cache cache SET last_used_at=now()
           WHERE cache.model_key=$4 AND cache.text_hash IN (
             SELECT text_hash FROM cached_chunks
           ) RETURNING cache.text_hash
         )
         SELECT (SELECT count(*) FROM retired_superseded) AS retired_superseded,
                (SELECT count(*) FROM retired_missing) AS retired_missing,
                (SELECT count(*) FROM retired_inactive) AS retired_inactive,
                (SELECT count(*) FROM completed) AS completed,
                (SELECT count(*) FROM cached_jobs) AS cache_hits`,
        [
          this.model.name,
          this.model.revision,
          this.model.dimensions,
          this.modelKey,
          Math.max(100, limit * 10),
        ],
      )
    ).rows[0] ?? {
      retired_superseded: 0,
      retired_missing: 0,
      retired_inactive: 0,
      completed: 0,
      cache_hits: 0,
    };
    const cacheHits = numeric(row.cache_hits);
    return {
      retired:
        numeric(row.retired_superseded) +
        numeric(row.retired_missing) +
        numeric(row.retired_inactive),
      completed: numeric(row.completed),
      reused: cacheHits,
      cacheHits,
    };
  }

  private async repairOrphans(client: PoolClient): Promise<number> {
    const row = (
      await client.query<{ reenqueued: number }>(
        `WITH orphan_candidates AS MATERIALIZED (
           SELECT c.id,c.project_id
           FROM project_knowledge.search_chunks c
           LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
           WHERE c.active AND c.embedding IS NULL
             AND (c.snapshot_id IS NULL OR s.state='active')
             AND c.kind<>'symbol'
             AND (c.snapshot_id IS NULL OR c.kind=ANY($1::text[]))
             AND NOT EXISTS (
               SELECT 1 FROM project_knowledge.outbox_jobs existing
               WHERE existing.project_id=c.project_id
                 AND existing.job_type='embed_chunk'
                 AND existing.job_key='embed:'||c.id::text
                 AND existing.state IN ('pending','failed','processing')
             )
           ORDER BY c.id LIMIT 500
         ), reenqueued AS (
           INSERT INTO project_knowledge.outbox_jobs
             (project_id,job_type,job_key,required_capability,payload)
           SELECT project_id,'embed_chunk','embed:'||id::text,'embedding',
                  jsonb_build_object('chunkId',id::text)
           FROM orphan_candidates ON CONFLICT DO NOTHING RETURNING id
         )
         SELECT count(*) AS reenqueued FROM reenqueued`,
        [[...EMBEDDABLE_CHUNK_KINDS]],
      )
    ).rows[0];
    return numeric(row?.reenqueued);
  }

  private async claim(
    client: PoolClient,
    limit: number,
  ): Promise<ClaimedJob[]> {
    return (
      await client.query<ClaimedJob>(
        `WITH fair AS (
           SELECT j.id,j.priority,j.created_at,
                  row_number() OVER (PARTITION BY j.project_id ORDER BY j.priority DESC,j.created_at,j.id) AS project_rank
           FROM project_knowledge.outbox_jobs j
           JOIN project_knowledge.search_chunks c ON c.id=(j.payload->>'chunkId')::uuid
           LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
           WHERE j.job_type='embed_chunk' AND j.required_capability='embedding'
             AND j.available_at<=now() AND j.attempts<j.max_attempts
             AND (j.state IN ('pending','failed') OR
                  (j.state='processing' AND (j.lease_expires_at IS NULL OR j.lease_expires_at<now())))
             AND c.active AND c.embedding IS NULL
             AND (c.snapshot_id IS NULL OR s.state='active')
         ), candidates AS (
           SELECT j.id FROM project_knowledge.outbox_jobs j
           JOIN fair ON fair.id=j.id
           ORDER BY fair.project_rank, fair.priority DESC, fair.created_at
           FOR UPDATE OF j SKIP LOCKED LIMIT $1
         )
         UPDATE project_knowledge.outbox_jobs jobs
         SET state='processing',locked_at=now(),attempts=attempts+1,
             lease_owner=$2,heartbeat_at=now(),lease_expires_at=now()+interval '2 minutes'
         FROM project_knowledge.search_chunks chunks
         WHERE jobs.id IN (SELECT id FROM candidates)
           AND chunks.id=(jobs.payload->>'chunkId')::uuid
         RETURNING jobs.id,chunks.id AS chunk_id,chunks.project_id,chunks.content,
                   chunks.content_hash,chunks.embed_hash,jobs.attempts`,
        [limit, this.workerId],
      )
    ).rows;
  }

  private async modelId(
    client: PoolClient,
    projectId: string,
  ): Promise<string> {
    const cached = this.modelIds.get(projectId);
    if (cached) return cached;
    const id = (
      await client.query<{ id: string }>(
        `INSERT INTO project_knowledge.embedding_models(project_id,model_name,model_revision,dimensions,active)
         VALUES($1,$2,$3,$4,true)
         ON CONFLICT(project_id,model_name,model_revision)
         DO UPDATE SET dimensions=EXCLUDED.dimensions,active=true RETURNING id`,
        [
          projectId,
          this.model.name,
          this.model.revision,
          this.model.dimensions,
        ],
      )
    ).rows[0]!.id;
    this.modelIds.set(projectId, id);
    return id;
  }

  private async targetProjectIds(
    client: PoolClient,
    keys: string[],
    claimedChunkIds: string[],
  ): Promise<string[]> {
    return (
      await client.query<{ project_id: string }>(
        `SELECT DISTINCT project_id FROM (
           SELECT c.project_id
           FROM project_knowledge.search_chunks c
           LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
           WHERE c.embed_hash=ANY($1::char(64)[])
             AND c.active AND c.embedding IS NULL
             AND (c.snapshot_id IS NULL OR s.state='active')
           UNION
           SELECT c.project_id
           FROM project_knowledge.search_chunks c
           LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
           WHERE c.id=ANY($2::uuid[])
             AND c.active
             AND (c.snapshot_id IS NULL OR s.state='active')
         ) targets`,
        [keys, claimedChunkIds],
      )
    ).rows.map(({ project_id }) => project_id);
  }

  private async applyVectors(
    client: PoolClient,
    jobs: PreparedJob[],
    vectors: Map<
      string,
      { vector: number[]; reason: 'embedded' | 'cache_hit' }
    >,
  ): Promise<number> {
    const keys = [...vectors.keys()];
    const projectIds = await this.targetProjectIds(
      client,
      keys,
      jobs.map(({ chunk_id }) => chunk_id),
    );
    projectIds.sort();
    const modelIds: string[] = [];
    for (const projectId of projectIds)
      modelIds.push(await this.modelId(client, projectId));
    const entries = keys.map((key) => vectors.get(key)!);
    const result = await client.query<{ applied: number }>(
      `WITH vector_data(text_hash,embedding,reason) AS MATERIALIZED (
         SELECT * FROM unnest($1::text[],$2::text[],$3::text[])
       ), model_data(project_id,model_id) AS MATERIALIZED (
         SELECT * FROM unnest($4::uuid[],$5::uuid[])
       ), claimed_data(chunk_id,text_hash,content_hash) AS MATERIALIZED (
         SELECT * FROM unnest($6::uuid[],$7::text[],$10::text[])
       ), targets AS MATERIALIZED (
         SELECT c.id,c.project_id,data.text_hash,data.embedding,data.reason,model.model_id,c.content_hash
         FROM project_knowledge.search_chunks c
         JOIN vector_data data ON c.embed_hash=data.text_hash
         JOIN model_data model ON model.project_id=c.project_id
         LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
         WHERE c.active AND c.embedding IS NULL
           AND (c.snapshot_id IS NULL OR s.state='active')
         UNION
         SELECT c.id,c.project_id,data.text_hash,data.embedding,data.reason,model.model_id,c.content_hash
         FROM claimed_data claimed
         JOIN project_knowledge.search_chunks c ON c.id=claimed.chunk_id
         JOIN vector_data data ON data.text_hash=claimed.text_hash
         JOIN model_data model ON model.project_id=c.project_id
         LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
         WHERE c.active AND c.embedding IS NULL AND c.content_hash=claimed.content_hash
           AND (c.snapshot_id IS NULL OR s.state='active')
       ), updated_chunks AS (
         UPDATE project_knowledge.search_chunks c
         SET embedding=target.embedding::vector,embedding_model_id=target.model_id,
             embed_hash=COALESCE(c.embed_hash,target.text_hash)
         FROM targets target WHERE c.id=target.id AND c.embedding IS NULL AND c.active
           AND c.content_hash=target.content_hash
           AND (c.embed_hash IS NULL OR c.embed_hash=target.text_hash)
         RETURNING c.id,target.text_hash,target.reason
       ), completed_chunks AS (
         SELECT id,text_hash,reason FROM updated_chunks
         UNION
         SELECT c.id,claimed.text_hash,'cache_hit'::text AS reason
         FROM claimed_data claimed
         JOIN project_knowledge.search_chunks c ON c.id=claimed.chunk_id
         JOIN model_data model ON model.project_id=c.project_id
         LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
         WHERE c.active AND c.embedding IS NOT NULL
           AND c.embed_hash=claimed.text_hash AND c.content_hash=claimed.content_hash
           AND c.embedding_model_id=model.model_id
           AND (c.snapshot_id IS NULL OR s.state='active')
       ), completed_jobs AS (
         UPDATE project_knowledge.outbox_jobs j
         SET state='done',finished_at=now(),locked_at=NULL,last_error=NULL,
             lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=now(),
             resolution=jsonb_build_object('reason',chunk.reason,'embedHash',chunk.text_hash)
         FROM completed_chunks chunk
         WHERE j.id=ANY($9::uuid[]) AND j.job_type='embed_chunk' AND j.state='processing'
           AND j.payload->>'chunkId'=chunk.id::text RETURNING j.id
       ), touched_cache AS (
         UPDATE project_knowledge.embedding_cache cache SET last_used_at=now()
         WHERE cache.model_key=$8 AND cache.text_hash::text=ANY($1::text[])
         RETURNING cache.text_hash
       )
       SELECT count(*) AS applied FROM updated_chunks`,
      [
        keys,
        entries.map(({ vector }) => `[${vector.join(',')}]`),
        entries.map(({ reason }) => reason),
        projectIds,
        modelIds,
        jobs.map(({ chunk_id }) => chunk_id),
        jobs.map(({ cacheKey }) => cacheKey),
        this.modelKey,
        jobs.map(({ id }) => id),
        jobs.map(({ content_hash }) => content_hash),
      ],
    );
    return numeric(result.rows[0]?.applied);
  }

  private async fail(
    client: PoolClient,
    jobs: ClaimedJob[],
    error: unknown,
  ): Promise<void> {
    if (jobs.length === 0) return;
    const message =
      error instanceof Error ? error.message.slice(0, 500) : 'Embedding failed';
    await client.query(
      `UPDATE project_knowledge.outbox_jobs
       SET state=CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'failed' END,
           finished_at=CASE WHEN attempts>=max_attempts THEN now() ELSE NULL END,
           locked_at=NULL,lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=now(),last_error=$2,
           resolution=CASE WHEN attempts>=max_attempts THEN jsonb_build_object('reason','max_attempts') ELSE resolution END,
           available_at=now()+make_interval(secs => LEAST(300,30*power(2,GREATEST(attempts-1,0)))::int)
       FROM unnest($1::uuid[],$4::int[]) AS claim(id,attempt)
       WHERE outbox_jobs.id=claim.id AND attempts=claim.attempt
         AND lease_owner=$3 AND state='processing' AND lease_expires_at>now()`,
      [
        jobs.map(({ id }) => id),
        message,
        this.workerId,
        jobs.map(({ attempts }) => attempts),
      ],
    );
  }

  async processBatch(limit = 50): Promise<EmbeddingBatchStats> {
    let client: PoolClient | undefined = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const swept = await this.sweep(client, limit);
      let reenqueued = 0;
      const now = this.now();
      if (
        this.lastOrphanRepairAt === undefined ||
        now - this.lastOrphanRepairAt >= this.orphanRepairIntervalMs
      ) {
        if (
          await claimMaintenanceWindow(
            client,
            'embedding-orphan-repair',
            this.orphanRepairIntervalMs,
          )
        )
          reenqueued = await this.repairOrphans(client);
        this.lastOrphanRepairAt = now;
      }
      const claimed = await this.claim(client, limit);
      await client.query('COMMIT');
      client.release();
      client = undefined;
      const jobs: PreparedJob[] = claimed.map((job) => ({
        ...job,
        cacheKey: job.embed_hash?.trim() || embeddingHash(job.content),
        embeddingContent: embeddingText(job.content),
      }));
      const representatives = [
        ...new Map(jobs.map((job) => [job.cacheKey, job])).values(),
      ];
      if (representatives.length === 0)
        return {
          claimed: claimed.length,
          embedded: 0,
          applied: 0,
          failed: 0,
          reenqueued,
          ...swept,
        };
      const heartbeat = setInterval(() => {
        void this.pool
          .query(
            `UPDATE project_knowledge.outbox_jobs SET heartbeat_at=now(),
               lease_expires_at=now()+interval '2 minutes'
             FROM unnest($1::uuid[],$3::int[]) AS claim(id,attempt)
             WHERE outbox_jobs.id=claim.id AND attempts=claim.attempt
               AND lease_owner=$2 AND state='processing' AND lease_expires_at>now()`,
            [
              claimed.map(({ id }) => id),
              this.workerId,
              claimed.map(({ attempts }) => attempts),
            ],
          )
          .catch(() => undefined);
      }, 15_000);
      heartbeat.unref();
      try {
        const byHash = new Map(
          representatives.map((job) => [job.cacheKey, job.embeddingContent]),
        );
        const coordinated = await new PgEmbeddingCoordinator(
          this.pool,
          this.model.dimensions,
        ).getOrComputeMany(
          this.modelKey,
          [...byHash.keys()],
          async (hashes) => {
            const texts = hashes.map((hash) => byHash.get(hash)!);
            return this.embedder.embedMany
              ? this.embedder.embedMany(texts)
              : Promise.all(texts.map((text) => this.embedder.embed(text)));
          },
        );
        const vectors = new Map<
          string,
          { vector: number[]; reason: 'embedded' | 'cache_hit' }
        >();
        let embedded = 0;
        for (const [hash, { vector, computed }] of coordinated) {
          vectors.set(hash, {
            vector,
            reason: computed ? 'embedded' : 'cache_hit',
          });
          if (computed) embedded++;
        }
        // Hold claim row locks only while publishing. Reclaimers cannot change
        // ownership between this check and the atomic chunk/job updates.
        client = await this.pool.connect();
        await client.query('BEGIN');
        let applied = 0;
        try {
          const owned = await client.query<{ id: string }>(
            `SELECT j.id FROM project_knowledge.outbox_jobs j
             JOIN unnest($1::uuid[],$3::int[]) AS claim(id,attempt) ON j.id=claim.id
             WHERE j.lease_owner=$2 AND j.attempts=claim.attempt
               AND j.state='processing' AND j.lease_expires_at>now()
             ORDER BY j.id FOR UPDATE OF j`,
            [
              jobs.map(({ id }) => id),
              this.workerId,
              jobs.map(({ attempts }) => attempts),
            ],
          );
          const ownedIds = new Set(owned.rows.map(({ id }) => id));
          const ownedJobs = jobs.filter(({ id }) => ownedIds.has(id));
          const ownedKeys = new Set(ownedJobs.map(({ cacheKey }) => cacheKey));
          if (ownedJobs.length > 0)
            applied = await this.applyVectors(
              client,
              ownedJobs,
              new Map([...vectors].filter(([key]) => ownedKeys.has(key))),
            );
          await client.query('COMMIT');
        } catch (error) {
          // Model rows first created in this transaction disappear on rollback.
          this.modelIds.clear();
          await client.query('ROLLBACK');
          throw error;
        }
        const batchCacheHits = representatives.length - embedded;
        return {
          claimed: claimed.length,
          embedded,
          applied,
          reused: swept.reused + batchCacheHits,
          cacheHits: swept.cacheHits + batchCacheHits,
          reenqueued,
          retired: swept.retired,
          completed: swept.completed,
          failed: 0,
        };
      } catch (error) {
        client ??= await this.pool.connect();
        await this.fail(client, claimed, error);
        return {
          claimed: claimed.length,
          embedded: 0,
          applied: 0,
          failed: claimed.length,
          reenqueued,
          ...swept,
        };
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client?.release();
    }
  }
}
