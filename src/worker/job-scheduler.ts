import type { Pool } from 'pg';
import { SharedJobQueue } from './shared-job-queue.js';

export class HourlySourceScheduler {
  constructor(
    private readonly pool: Pool,
    private readonly queue: SharedJobQueue,
    private readonly intervalSeconds = 3600,
  ) {}

  async runIfDue(workerId: string): Promise<number> {
    const due = (
      await this.pool.query(
        `INSERT INTO project_knowledge.worker_scheduler_state
           (scheduler_key,last_run_at,next_run_at,last_worker_id)
         VALUES('source-sync-hourly',now(),now()+make_interval(secs=>$1),$2)
         ON CONFLICT(scheduler_key) DO UPDATE SET
           last_run_at=now(),next_run_at=now()+make_interval(secs=>$1),last_worker_id=$2
         WHERE project_knowledge.worker_scheduler_state.next_run_at<=now()
         RETURNING scheduler_key`,
        [this.intervalSeconds, workerId],
      )
    ).rows.length;
    if (!due) return 0;
    const worktrees = (
      await this.pool.query<{ project_id: string; worktree_id: string }>(
        `SELECT project_id,id AS worktree_id FROM project_knowledge.worktrees
         WHERE registered ORDER BY project_id,last_seen_at DESC`,
      )
    ).rows;
    for (const worktree of worktrees)
      await this.queue.enqueueSourceSync(
        worktree.project_id,
        worktree.worktree_id,
        'scheduled',
      );
    return worktrees.length;
  }
}
