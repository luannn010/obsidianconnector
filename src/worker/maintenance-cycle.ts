import type { Pool } from 'pg';
import type { SharedJobQueue } from './shared-job-queue.js';
import { pruneSupersededSnapshots } from './snapshot-cleanup.js';

export async function runMaintenanceCycle(
  pool: Pool,
  queue: Pick<SharedJobQueue, 'recoverExpiredLeases'>,
  retentionDays: number,
  onError: (error: unknown) => void,
): Promise<number> {
  let work = 0;
  try {
    work += await queue.recoverExpiredLeases();
  } catch (error) {
    onError(error);
  }
  const projects = (
    await pool.query<{ project_key: string }>(
      'SELECT project_key FROM project_knowledge.projects ORDER BY project_key',
    )
  ).rows;
  for (const project of projects) {
    try {
      const stats = await pruneSupersededSnapshots(
        pool,
        project.project_key,
        retentionDays,
      );
      work += stats.deletedSnapshots;
    } catch (error) {
      onError(error);
      break;
    }
  }
  return work;
}
