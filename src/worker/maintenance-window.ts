import type { PgPoolLike } from '../knowledge/pg-store.js';
import { randomUUID } from 'node:crypto';

export async function claimMaintenanceWindow(
  pool: Pick<PgPoolLike, 'query'>,
  task: string,
  intervalMs: number,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO project_knowledge.worker_maintenance_schedule(task_key,next_run_at)
     VALUES($1,clock_timestamp()+$2::int*interval '1 millisecond')
     ON CONFLICT(task_key) DO UPDATE SET next_run_at=EXCLUDED.next_run_at
       WHERE worker_maintenance_schedule.next_run_at<=clock_timestamp()
     RETURNING task_key`,
    [task, intervalMs],
  );
  return result.rows.length > 0;
}

export async function runMaintenanceWithLease<T>(
  pool: Pick<PgPoolLike, 'query'>,
  task: string,
  intervalMs: number,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const owner = randomUUID();
  const acquired = await pool.query(
    `INSERT INTO project_knowledge.worker_maintenance_schedule(task_key,next_run_at,lease_owner,lease_expires_at)
     VALUES($1,now(),$2::uuid,clock_timestamp()+interval '5 minutes')
     ON CONFLICT(task_key) DO UPDATE SET lease_owner=EXCLUDED.lease_owner,lease_expires_at=EXCLUDED.lease_expires_at
       WHERE worker_maintenance_schedule.next_run_at<=clock_timestamp()
         AND (worker_maintenance_schedule.lease_expires_at IS NULL OR worker_maintenance_schedule.lease_expires_at<=clock_timestamp())
     RETURNING task_key`,
    [task, owner],
  );
  if (!acquired.rows.length) return undefined;
  const heartbeat = setInterval(() => {
    void pool
      .query(
        `UPDATE project_knowledge.worker_maintenance_schedule SET lease_expires_at=clock_timestamp()+interval '5 minutes'
       WHERE task_key=$1 AND lease_owner=$2::uuid AND lease_expires_at>clock_timestamp()`,
        [task, owner],
      )
      .catch(() => undefined);
  }, 60_000);
  heartbeat.unref();
  let retryMs = 60_000;
  try {
    const result = await work();
    retryMs = intervalMs;
    return result;
  } finally {
    clearInterval(heartbeat);
    await pool.query(
      `UPDATE project_knowledge.worker_maintenance_schedule
       SET next_run_at=clock_timestamp()+$3::int*interval '1 millisecond',lease_owner=NULL,lease_expires_at=NULL
       WHERE task_key=$1 AND lease_owner=$2::uuid AND lease_expires_at>clock_timestamp()`,
      [task, owner, retryMs],
    );
  }
}
