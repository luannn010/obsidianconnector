import type { Pool } from 'pg';
import type { SharedJobQueue } from './shared-job-queue.js';
import {
  pruneSupersededSnapshotPayload,
  pruneSupersededSnapshots,
} from './snapshot-cleanup.js';

export async function runMaintenanceCycle(
  pool: Pool,
  queue: Pick<SharedJobQueue, 'recoverExpiredLeases'>,
  retentionDays: number,
  onError: (error: unknown) => void,
  payloadRetentionDays = 2,
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
  try {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const stats = await pruneSupersededSnapshotPayload(pool, {
        retentionDays: payloadRetentionDays,
      });
      work += stats.prunedSnapshots;
      if (stats.prunedSnapshots === 0) break;
    }
  } catch (error) {
    onError(error);
  }
  return work;
}
