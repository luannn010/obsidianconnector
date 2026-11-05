import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { WorkerCapability } from './shared-job-queue.js';

export function createWorkerInstanceId(
  hostKind: 'windows' | 'debian',
  hostname: string,
  pid: number,
): string {
  // Host-network containers can share both the hostname and PID 1.
  // A process nonce also prevents a restarted worker inheriting old leases.
  return `${hostKind}-${hostname}-${pid}-${randomUUID()}`;
}

export class WorkerInstanceRegistry {
  constructor(
    private readonly pool: Pool,
    readonly workerId: string,
    private readonly hostKind: 'windows' | 'debian',
    private readonly capabilities: WorkerCapability[],
    private readonly releaseId?: string,
  ) {}

  async heartbeat(
    currentJobId?: string,
    stats: { processed?: number; failed?: number; error?: string } = {},
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO project_knowledge.worker_instances
         (worker_id,host_kind,capabilities,release_id,heartbeat_at,current_job_id,
          processed_count,failed_count,last_error,details)
       VALUES($1,$2,$3,$4,now(),$5,$6,$7,$8,'{}'::jsonb)
       ON CONFLICT(worker_id) DO UPDATE SET
         host_kind=EXCLUDED.host_kind,capabilities=EXCLUDED.capabilities,
         release_id=EXCLUDED.release_id,heartbeat_at=now(),current_job_id=EXCLUDED.current_job_id,
         processed_count=project_knowledge.worker_instances.processed_count+EXCLUDED.processed_count,
         failed_count=project_knowledge.worker_instances.failed_count+EXCLUDED.failed_count,
         last_error=EXCLUDED.last_error`,
      [
        this.workerId,
        this.hostKind,
        this.capabilities,
        this.releaseId ?? null,
        currentJobId ?? null,
        stats.processed ?? 0,
        stats.failed ?? 0,
        stats.error ?? null,
      ],
    );
  }

  async hasFreshDebianEmbeddingWorker(maxAgeSeconds = 120): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM project_knowledge.worker_instances
       WHERE host_kind='debian' AND capabilities@>ARRAY['embedding']::text[]
         AND heartbeat_at>now()-make_interval(secs=>$1) LIMIT 1`,
      [maxAgeSeconds],
    );
    return result.rows.length > 0;
  }
}
