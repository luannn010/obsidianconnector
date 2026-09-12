import type { Pool, PoolClient } from 'pg';
import type { EmbeddingProvider } from '../knowledge/pg-store.js';

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
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class EmbeddingQueueProcessor {
  constructor(
    private readonly pool: Pool,
    private readonly embedder: EmbeddingProvider,
    private readonly model: EmbeddingModelIdentity,
  ) {}

  private async sweep(client: PoolClient, limit: number): Promise<Omit<EmbeddingBatchStats, 'claimed' | 'embedded' | 'applied' | 'failed'>> {
    const row = (
      await client.query<{
        retired_superseded: number;
        retired_missing: number;
        completed: number;
        reused: number;
      }>(
        `WITH live AS MATERIALIZED (
           SELECT j.id,j.project_id,j.payload->>'chunkId' AS chunk_id
           FROM project_knowledge.outbox_jobs j
           WHERE j.job_type='embed_chunk' AND j.state IN ('pending','failed','processing')
           ORDER BY j.created_at LIMIT $4
         ), retired_missing AS (
           UPDATE project_knowledge.outbox_jobs j
           SET state='superseded',finished_at=now(),locked_at=NULL,last_error=NULL,
               resolution=jsonb_build_object('reason','missing_chunk')
           FROM live l
           WHERE j.id=l.id AND NOT EXISTS (
             SELECT 1 FROM project_knowledge.search_chunks c WHERE c.id=l.chunk_id::uuid
           ) RETURNING j.id
         ), retired_superseded AS (
           UPDATE project_knowledge.outbox_jobs j
           SET state='superseded',finished_at=now(),locked_at=NULL,last_error=NULL,
               resolution=jsonb_build_object('reason','superseded_snapshot')
           FROM live l JOIN project_knowledge.search_chunks c ON c.id=l.chunk_id::uuid
           JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
           WHERE j.id=l.id AND s.state<>'active' RETURNING j.id
         ), completed AS (
           UPDATE project_knowledge.outbox_jobs j
           SET state='done',finished_at=now(),locked_at=NULL,last_error=NULL,
               resolution=jsonb_build_object('reason','already_embedded')
           FROM live l JOIN project_knowledge.search_chunks c ON c.id=l.chunk_id::uuid
           LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
           WHERE j.id=l.id AND c.embedding IS NOT NULL
             AND (c.snapshot_id IS NULL OR s.state='active') RETURNING j.id
         ), reusable AS (
           SELECT DISTINCT ON (target.id) target.id,candidate.embedding,candidate.embedding_model_id
           FROM live l
           JOIN project_knowledge.search_chunks target ON target.id=l.chunk_id::uuid
           LEFT JOIN project_knowledge.source_snapshots target_snapshot ON target_snapshot.id=target.snapshot_id
           JOIN project_knowledge.search_chunks candidate
             ON candidate.project_id=target.project_id AND candidate.content_hash=target.content_hash
            AND candidate.embedding IS NOT NULL AND candidate.id<>target.id
           JOIN project_knowledge.embedding_models model ON model.id=candidate.embedding_model_id
           WHERE target.embedding IS NULL AND (target.snapshot_id IS NULL OR target_snapshot.state='active')
             AND model.model_name=$1 AND model.model_revision=$2 AND model.dimensions=$3
           ORDER BY target.id,candidate.id
         ), reused_chunks AS (
           UPDATE project_knowledge.search_chunks target
           SET embedding=reusable.embedding,embedding_model_id=reusable.embedding_model_id
           FROM reusable WHERE target.id=reusable.id RETURNING target.id
         ), reused AS (
           UPDATE project_knowledge.outbox_jobs j
           SET state='done',finished_at=now(),locked_at=NULL,last_error=NULL,
               resolution=jsonb_build_object('reason','reused_embedding')
           FROM reused_chunks r WHERE j.payload->>'chunkId'=r.id::text
             AND j.job_type='embed_chunk' AND j.state IN ('pending','failed','processing')
           RETURNING j.id
         )
         SELECT (SELECT count(*) FROM retired_superseded) AS retired_superseded,
                (SELECT count(*) FROM retired_missing) AS retired_missing,
                (SELECT count(*) FROM completed) AS completed,
                (SELECT count(*) FROM reused) AS reused`,
        [this.model.name, this.model.revision, this.model.dimensions, Math.max(100, limit * 10)],
      )
    ).rows[0] ?? {
      retired_superseded: 0,
      retired_missing: 0,
      completed: 0,
      reused: 0,
    };
    return {
      retired: numeric(row.retired_superseded) + numeric(row.retired_missing),
      completed: numeric(row.completed),
      reused: numeric(row.reused),
    };
  }

  private async claim(client: PoolClient, limit: number): Promise<ClaimedJob[]> {
    return (
      await client.query<ClaimedJob>(
        `WITH candidates AS (
           SELECT j.id
           FROM project_knowledge.outbox_jobs j
           JOIN project_knowledge.search_chunks c ON c.id=(j.payload->>'chunkId')::uuid
           LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
           WHERE j.job_type='embed_chunk' AND j.available_at<=now()
             AND (j.state IN ('pending','failed') OR (j.state='processing' AND j.locked_at<=now()-interval '5 minutes'))
             AND c.embedding IS NULL AND (c.snapshot_id IS NULL OR s.state='active')
           ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT $1
         )
         UPDATE project_knowledge.outbox_jobs jobs
         SET state='processing',locked_at=now(),attempts=attempts+1
         FROM project_knowledge.search_chunks chunks
         WHERE jobs.id IN (SELECT id FROM candidates)
           AND chunks.id=(jobs.payload->>'chunkId')::uuid
         RETURNING jobs.id,chunks.id AS chunk_id,chunks.project_id,chunks.content,chunks.content_hash`,
        [limit],
      )
    ).rows;
  }

  private async modelId(client: PoolClient, projectId: string): Promise<string> {
    return (
      await client.query<{ id: string }>(
        `INSERT INTO project_knowledge.embedding_models(project_id,model_name,model_revision,dimensions,active)
         VALUES($1,$2,$3,$4,true)
         ON CONFLICT(project_id,model_name,model_revision)
         DO UPDATE SET dimensions=EXCLUDED.dimensions,active=true RETURNING id`,
        [projectId, this.model.name, this.model.revision, this.model.dimensions],
      )
    ).rows[0]!.id;
  }

  private async applyVector(client: PoolClient, job: ClaimedJob, vector: number[]): Promise<number> {
    if (vector.length !== this.model.dimensions)
      throw new Error(`Embedding dimension mismatch: ${vector.length}`);
    const modelId = await this.modelId(client, job.project_id);
    const result = await client.query<{ applied: number }>(
      `WITH current_chunks AS (
         SELECT c.id FROM project_knowledge.search_chunks c
         LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
         WHERE c.project_id=$1 AND c.content_hash=$2 AND c.embedding IS NULL
           AND (c.snapshot_id IS NULL OR s.state='active')
       ), updated_chunks AS (
         UPDATE project_knowledge.search_chunks c
         SET embedding=$3::vector,embedding_model_id=$4
         WHERE c.id IN (SELECT id FROM current_chunks) RETURNING c.id
       ), completed_jobs AS (
         UPDATE project_knowledge.outbox_jobs j
         SET state='done',finished_at=now(),locked_at=NULL,last_error=NULL,
             resolution=jsonb_build_object('reason','embedded','contentHash',$2)
         WHERE j.job_type='embed_chunk' AND j.state IN ('pending','failed','processing')
           AND (j.payload->>'chunkId')::uuid IN (
             SELECT c.id FROM project_knowledge.search_chunks c
             WHERE c.project_id=$1 AND c.content_hash=$2 AND c.embedding_model_id=$4
           ) RETURNING j.id
       ) SELECT count(*) AS applied FROM updated_chunks`,
      [job.project_id, job.content_hash, `[${vector.join(',')}]`, modelId],
    );
    return numeric(result.rows[0]?.applied);
  }

  private async fail(client: PoolClient, jobs: ClaimedJob[], error: unknown): Promise<void> {
    if (jobs.length === 0) return;
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Embedding failed';
    await client.query(
      `UPDATE project_knowledge.outbox_jobs
       SET state='failed',locked_at=NULL,last_error=$2,
           available_at=now()+make_interval(secs => LEAST(300,30*power(2,GREATEST(attempts-1,0)))::int)
       WHERE id=ANY($1::uuid[])`,
      [jobs.map(({ id }) => id), message],
    );
  }

  async processBatch(limit = 50): Promise<EmbeddingBatchStats> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const swept = await this.sweep(client, limit);
      const jobs = await this.claim(client, limit);
      await client.query('COMMIT');
      const representatives = [
        ...new Map(jobs.map((job) => [`${job.project_id}\0${job.content_hash}`, job])).values(),
      ];
      if (representatives.length === 0)
        return { claimed: jobs.length, embedded: 0, applied: 0, failed: 0, ...swept };
      try {
        const vectors = this.embedder.embedMany
          ? await this.embedder.embedMany(representatives.map(({ content }) => content))
          : await Promise.all(representatives.map(({ content }) => this.embedder.embed(content)));
        if (vectors.length !== representatives.length)
          throw new Error(`Embedding batch returned ${vectors.length} vectors for ${representatives.length} chunks`);
        let applied = 0;
        for (const [index, job] of representatives.entries())
          applied += await this.applyVector(client, job, vectors[index]!);
        return { claimed: jobs.length, embedded: representatives.length, applied, failed: 0, ...swept };
      } catch (error) {
        await this.fail(client, jobs, error);
        return { claimed: jobs.length, embedded: 0, applied: 0, failed: jobs.length, ...swept };
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
