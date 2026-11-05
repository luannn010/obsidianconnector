import type { Pool } from 'pg';

export type WorkerCapability =
  'source-sync' | 'publish' | 'embedding' | 'maintenance' | 'scheduler';

export interface SharedJob {
  id: string;
  project_id: string;
  job_type: string;
  payload: Record<string, unknown>;
  job_key: string;
  required_capability: WorkerCapability;
  attempts: number;
  max_attempts: number;
}

export class SharedJobQueue {
  constructor(private readonly pool: Pool) {}

  async enqueueSourceSync(
    projectId: string,
    worktreeId: string,
    reason: 'on_demand' | 'scheduled',
    priority = reason === 'on_demand' ? 100 : 10,
  ): Promise<{ jobId: string; created: boolean }> {
    const row = (
      await this.pool.query<{ id: string; inserted: boolean }>(
        `INSERT INTO project_knowledge.outbox_jobs
           (project_id,job_type,job_key,required_capability,priority,payload)
         VALUES($1,'source_sync',$2,'source-sync',$3,$4::jsonb)
         ON CONFLICT(project_id,job_type,job_key)
           WHERE state IN ('pending','failed','processing')
         DO UPDATE SET priority=GREATEST(project_knowledge.outbox_jobs.priority,EXCLUDED.priority),
                       available_at=LEAST(project_knowledge.outbox_jobs.available_at,now())
         RETURNING id,(xmax=0) AS inserted`,
        [
          projectId,
          `source-sync:${worktreeId}`,
          priority,
          JSON.stringify({
            version: 1,
            jobType: 'source_sync',
            worktreeId,
            requestedBy:
              reason === 'on_demand' ? 'windows-cli' : 'debian-scheduler',
            reason,
          }),
        ],
      )
    ).rows[0]!;
    return { jobId: row.id, created: Boolean(row.inserted) };
  }

  async claim(
    capabilities: WorkerCapability[],
    workerId: string,
    limit: number,
    leaseSeconds = 120,
    options: { sourceWorktreeId?: string } = {},
  ): Promise<SharedJob[]> {
    if (capabilities.length === 0) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const jobs = (
        await client.query<SharedJob>(
          `WITH fair AS (
             SELECT id,project_id,priority,created_at,
                    row_number() OVER (PARTITION BY project_id ORDER BY priority DESC,created_at,id) AS project_rank
             FROM project_knowledge.outbox_jobs
             WHERE required_capability=ANY($1::text[]) AND available_at<=now()
               AND ($5::text IS NULL OR job_type<>'source_sync' OR payload->>'worktreeId'=$5)
               AND attempts<max_attempts
               AND (state IN ('pending','failed') OR
                    (state='processing' AND lease_expires_at<now()))
           ), candidates AS (
             SELECT job.id
             FROM project_knowledge.outbox_jobs job
             JOIN fair ON fair.id=job.id
             WHERE fair.project_rank=1
             ORDER BY fair.project_rank,fair.priority DESC,fair.created_at
             FOR UPDATE OF job SKIP LOCKED LIMIT $2
           )
           UPDATE project_knowledge.outbox_jobs job
           SET state='processing',lease_owner=$3,locked_at=now(),heartbeat_at=now(),
               lease_expires_at=now()+make_interval(secs=>$4),attempts=attempts+1
           WHERE job.id IN (SELECT id FROM candidates)
           RETURNING job.id,job.project_id,job.job_type,job.payload,job.job_key,
                     job.required_capability,job.attempts,job.max_attempts`,
          [
            capabilities,
            limit,
            workerId,
            leaseSeconds,
            options.sourceWorktreeId?.trim() || null,
          ],
        )
      ).rows;
      await client.query('COMMIT');
      return jobs;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async renew(
    jobId: string,
    workerId: string,
    leaseSeconds = 120,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE project_knowledge.outbox_jobs SET heartbeat_at=now(),
         lease_expires_at=now()+make_interval(secs=>$3)
       WHERE id=$1 AND lease_owner=$2 AND state='processing'`,
      [jobId, workerId, leaseSeconds],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async complete(
    jobId: string,
    workerId: string,
    resolution: object,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE project_knowledge.outbox_jobs
       SET state='done',finished_at=now(),lease_owner=NULL,lease_expires_at=NULL,
           heartbeat_at=now(),last_error=NULL,
           resolution=jsonb_build_object('assignedWorker',$2)||$3::jsonb
       WHERE id=$1 AND lease_owner=$2 AND state='processing'`,
      [jobId, workerId, JSON.stringify(resolution)],
    );
  }

  async fail(job: SharedJob, workerId: string, error: unknown): Promise<void> {
    const message =
      error instanceof Error
        ? error.message.slice(0, 500)
        : String(error).slice(0, 500);
    const terminal = job.attempts >= job.max_attempts;
    await this.pool.query(
      `UPDATE project_knowledge.outbox_jobs
       SET state=$3,finished_at=CASE WHEN $3='dead' THEN now() ELSE NULL END,
           lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=now(),last_error=$4,
           available_at=now()+make_interval(secs=>LEAST(600,30*power(2,GREATEST(attempts-1,0)))::int),
           resolution=CASE WHEN $3='dead' THEN jsonb_build_object('reason','max_attempts') ELSE resolution END
       WHERE id=$1 AND lease_owner=$2 AND state='processing'`,
      [job.id, workerId, terminal ? 'dead' : 'failed', message],
    );
  }

  async recoverExpiredLeases(): Promise<number> {
    const recovered = await this.pool.query(
      `UPDATE project_knowledge.outbox_jobs SET state='pending',lease_owner=NULL,
         lease_expires_at=NULL,heartbeat_at=NULL,available_at=now(),
         last_error='Worker lease expired; job returned to its required capability'
       WHERE state='processing' AND lease_expires_at<now() AND attempts<max_attempts`,
    );
    await this.pool.query(
      `UPDATE project_knowledge.outbox_jobs SET state='dead',finished_at=now(),
         lease_owner=NULL,lease_expires_at=NULL,
         resolution=jsonb_build_object('reason','expired_after_max_attempts')
       WHERE state='processing' AND lease_expires_at<now() AND attempts>=max_attempts`,
    );
    return recovered.rowCount ?? 0;
  }

  async find(jobId: string): Promise<
    | (SharedJob & {
        state: string;
        resolution: Record<string, unknown>;
        lease_owner: string | null;
        last_error: string | null;
      })
    | undefined
  > {
    return (
      await this.pool.query<
        SharedJob & {
          state: string;
          resolution: Record<string, unknown>;
          lease_owner: string | null;
          last_error: string | null;
        }
      >(
        `SELECT id,project_id,job_type,payload,job_key,required_capability,attempts,max_attempts,
                state,resolution,lease_owner,last_error
         FROM project_knowledge.outbox_jobs WHERE id=$1`,
        [jobId],
      )
    ).rows[0];
  }
}
