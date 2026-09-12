import type { Pool } from 'pg';

export interface SnapshotCleanupStats {
  eligibleSnapshots: number;
  deletedSnapshots: number;
  deletedJobs: number;
  deletedSymbols: number;
  deletedChunks: number;
  deletedFiles: number;
  deletedFreshnessRows: number;
}

export async function pruneSupersededSnapshots(
  pool: Pool,
  projectKey: string,
  retentionDays = 7,
): Promise<SnapshotCleanupStats> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const snapshots = (
      await client.query<{ id: string }>(
        `SELECT snapshot.id
         FROM project_knowledge.source_snapshots snapshot
         JOIN project_knowledge.projects project ON project.project_id=snapshot.project_id
         WHERE project.project_key=$1 AND snapshot.state='superseded'
           AND COALESCE(snapshot.activated_at,snapshot.created_at)<now()-($2*interval '1 day')
           AND NOT EXISTS (SELECT 1 FROM project_knowledge.source_evidence evidence WHERE evidence.snapshot_id=snapshot.id)
           AND NOT EXISTS (SELECT 1 FROM project_knowledge.agent_tasks task WHERE task.start_snapshot_id=snapshot.id OR task.end_snapshot_id=snapshot.id)
           AND NOT EXISTS (SELECT 1 FROM project_knowledge.file_activity_events activity WHERE activity.snapshot_id=snapshot.id)
           AND NOT EXISTS (SELECT 1 FROM project_knowledge.note_projections projection WHERE projection.source_snapshot_id=snapshot.id)
           AND NOT EXISTS (SELECT 1 FROM project_knowledge.domain_sync_states sync WHERE sync.source_snapshot_id=snapshot.id)
         ORDER BY snapshot.created_at
         FOR UPDATE OF snapshot`,
        [projectKey, retentionDays],
      )
    ).rows;
    const ids = snapshots.map(({ id }) => id);
    if (ids.length === 0) {
      await client.query('COMMIT');
      return {
        eligibleSnapshots: 0,
        deletedSnapshots: 0,
        deletedJobs: 0,
        deletedSymbols: 0,
        deletedChunks: 0,
        deletedFiles: 0,
        deletedFreshnessRows: 0,
      };
    }
    const deletedJobs = await client.query(
      `DELETE FROM project_knowledge.outbox_jobs job
       WHERE job.job_type='embed_chunk' AND (job.payload->>'chunkId')::uuid IN (
         SELECT id FROM project_knowledge.search_chunks WHERE snapshot_id=ANY($1::uuid[])
       )`,
      [ids],
    );
    const deletedSymbols = await client.query(
      'DELETE FROM project_knowledge.code_symbols WHERE snapshot_id=ANY($1::uuid[])',
      [ids],
    );
    const deletedChunks = await client.query(
      'DELETE FROM project_knowledge.search_chunks WHERE snapshot_id=ANY($1::uuid[])',
      [ids],
    );
    const deletedFiles = await client.query(
      'DELETE FROM project_knowledge.code_files WHERE snapshot_id=ANY($1::uuid[])',
      [ids],
    );
    const deletedFreshnessRows = await client.query(
      'DELETE FROM project_knowledge.documentation_freshness WHERE snapshot_id=ANY($1::uuid[])',
      [ids],
    );
    const deletedSnapshots = await client.query<{ id: string }>(
      'DELETE FROM project_knowledge.source_snapshots WHERE id=ANY($1::uuid[]) RETURNING id',
      [ids],
    );
    await client.query('COMMIT');
    return {
      eligibleSnapshots: ids.length,
      deletedSnapshots: deletedSnapshots.rows.length,
      deletedJobs: deletedJobs.rowCount ?? 0,
      deletedSymbols: deletedSymbols.rowCount ?? 0,
      deletedChunks: deletedChunks.rowCount ?? 0,
      deletedFiles: deletedFiles.rowCount ?? 0,
      deletedFreshnessRows: deletedFreshnessRows.rowCount ?? 0,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
