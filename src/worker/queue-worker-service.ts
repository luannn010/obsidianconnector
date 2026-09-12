import type { Pool } from 'pg';
import type { EmbeddingBatchStats } from './embedding-queue-processor.js';

interface BatchProcessor {
  processBatch(limit: number): Promise<EmbeddingBatchStats>;
}

export interface QueueWorkerOptions {
  projectKey: string;
  releaseId?: string;
  workerRole?: string;
}

export class QueueWorkerService {
  private readonly workerRole: string;

  constructor(
    private readonly pool: Pool,
    private readonly processor: BatchProcessor,
    private readonly options: QueueWorkerOptions,
  ) {
    this.workerRole = options.workerRole ?? 'embedding-queue';
  }

  async runOnce(limit: number): Promise<EmbeddingBatchStats> {
    const stats = await this.processor.processBatch(limit);
    await this.recordHeartbeat(stats);
    return stats;
  }

  async recordError(error: unknown): Promise<void> {
    await this.recordHeartbeat(undefined, error);
  }

  private async recordHeartbeat(stats?: EmbeddingBatchStats, error?: unknown): Promise<void> {
    const project = (
      await this.pool.query<{ project_id: string }>(
        'SELECT project_id FROM project_knowledge.projects WHERE project_key=$1',
        [this.options.projectKey],
      )
    ).rows[0];
    if (!project) throw new Error(`Unknown project: ${this.options.projectKey}`);
    const queue = (
      await this.pool.query<{ pending: number; failed: number }>(
        `SELECT count(*) FILTER (WHERE state IN ('pending','processing')) AS pending,
                count(*) FILTER (WHERE state='failed') AS failed
         FROM project_knowledge.outbox_jobs
         WHERE project_id=$1 AND job_type='embed_chunk'`,
        [project.project_id],
      )
    ).rows[0] ?? { pending: 0, failed: 0 };
    const lastError = error instanceof Error ? error.message.slice(0, 500) : error ? String(error).slice(0, 500) : null;
    await this.pool.query(
      `INSERT INTO project_knowledge.worker_health
         (project_id,worker_role,release_id,heartbeat_at,last_successful_batch_at,
          processed_count,reused_count,retired_count,pending_count,failed_count,last_error,details)
       VALUES($1,$2,$3,now(),CASE WHEN $4::boolean THEN now() ELSE NULL END,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT(project_id,worker_role) DO UPDATE SET
         release_id=EXCLUDED.release_id,heartbeat_at=now(),
         last_successful_batch_at=CASE WHEN $4::boolean THEN now() ELSE project_knowledge.worker_health.last_successful_batch_at END,
         processed_count=project_knowledge.worker_health.processed_count+EXCLUDED.processed_count,
         reused_count=project_knowledge.worker_health.reused_count+EXCLUDED.reused_count,
         retired_count=project_knowledge.worker_health.retired_count+EXCLUDED.retired_count,
         pending_count=EXCLUDED.pending_count,failed_count=EXCLUDED.failed_count,
         last_error=EXCLUDED.last_error,details=EXCLUDED.details`,
      [
        project.project_id,
        this.workerRole,
        this.options.releaseId ?? null,
        Boolean(stats && stats.failed === 0 && !error),
        stats?.applied ?? 0,
        stats?.reused ?? 0,
        stats?.retired ?? 0,
        Number(queue.pending ?? 0),
        Number(queue.failed ?? 0),
        lastError,
        JSON.stringify(stats ?? {}),
      ],
    );
  }
}
