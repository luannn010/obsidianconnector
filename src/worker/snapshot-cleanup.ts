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

export interface SnapshotPayloadCleanupOptions {
  retentionDays?: number;
  maxSnapshots?: number;
  projectKey?: string;
}

export interface SnapshotPayloadCleanupStats {
  eligibleSnapshots: number;
  prunedSnapshots: number;
  deletedJobs: number;
  deletedSymbols: number;
  deletedChunks: number;
  deletedFiles: number;
  keptEvidenceChunks: number;
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

export async function pruneSupersededSnapshotPayload(
  pool: Pool,
  options: SnapshotPayloadCleanupOptions = {},
): Promise<SnapshotPayloadCleanupStats> {
  const retentionDays = options.retentionDays ?? 2;
  const maxSnapshots = options.maxSnapshots ?? 10;
  const client = await pool.connect();
  try {
    const projectJoin = options.projectKey
      ? 'JOIN project_knowledge.projects project ON project.project_id=snapshot.project_id'
      : '';
    const projectFilter = options.projectKey
      ? 'AND project.project_key=$3'
      : '';
    const params = options.projectKey
      ? [retentionDays, maxSnapshots, options.projectKey]
      : [retentionDays, maxSnapshots];
    const snapshots = (
      await client.query<{ id: string; project_id: string }>(
        `SELECT snapshot.id,snapshot.project_id
         FROM project_knowledge.source_snapshots snapshot
         ${projectJoin}
         WHERE snapshot.state='superseded'
           AND COALESCE(snapshot.activated_at,snapshot.created_at)<now()-($1*interval '1 day')
           ${projectFilter}
           AND (
             EXISTS (
               SELECT 1 FROM project_knowledge.search_chunks chunk
               WHERE chunk.project_id=snapshot.project_id
                 AND chunk.snapshot_id=snapshot.id
                 AND NOT EXISTS (
                   SELECT 1 FROM project_knowledge.source_evidence evidence
                   WHERE evidence.metadata->>'ref' = 'chunk:'||chunk.id::text
                 )
             )
             OR EXISTS (
               SELECT 1 FROM project_knowledge.code_symbols symbol
               WHERE symbol.snapshot_id=snapshot.id
             )
           )
         ORDER BY COALESCE(snapshot.activated_at,snapshot.created_at),snapshot.id
         LIMIT $2`,
        params,
      )
    ).rows;

    const stats: SnapshotPayloadCleanupStats = {
      eligibleSnapshots: snapshots.length,
      prunedSnapshots: 0,
      deletedJobs: 0,
      deletedSymbols: 0,
      deletedChunks: 0,
      deletedFiles: 0,
      keptEvidenceChunks: 0,
    };

    for (const snapshot of snapshots) {
      await client.query('BEGIN');
      try {
        const lockProjectFilter = options.projectKey
          ? `AND EXISTS (
               SELECT 1 FROM project_knowledge.projects project
               WHERE project.project_id=snapshot.project_id
                 AND project.project_key=$3
             )`
          : '';
        const lockParams = options.projectKey
          ? [snapshot.id, retentionDays, options.projectKey]
          : [snapshot.id, retentionDays];
        const locked = await client.query<{ id: string; project_id: string }>(
          `SELECT snapshot.id,snapshot.project_id
           FROM project_knowledge.source_snapshots snapshot
           WHERE snapshot.id=$1 AND snapshot.state='superseded'
             AND COALESCE(snapshot.activated_at,snapshot.created_at)<now()-($2*interval '1 day')
             ${lockProjectFilter}
             AND (
               EXISTS (
                 SELECT 1 FROM project_knowledge.search_chunks chunk
                 WHERE chunk.project_id=snapshot.project_id
                   AND chunk.snapshot_id=snapshot.id
                   AND NOT EXISTS (
                     SELECT 1 FROM project_knowledge.source_evidence evidence
                     WHERE evidence.metadata->>'ref' = 'chunk:'||chunk.id::text
                   )
               )
               OR EXISTS (
                 SELECT 1 FROM project_knowledge.code_symbols symbol
                 WHERE symbol.snapshot_id=snapshot.id
               )
           )
           FOR UPDATE OF snapshot SKIP LOCKED`,
          lockParams,
        );
        const lockedSnapshot = locked.rows[0];
        if (!lockedSnapshot) {
          await client.query('COMMIT');
          continue;
        }

        const deletedJobs = await client.query(
          `DELETE FROM project_knowledge.outbox_jobs job
           USING project_knowledge.search_chunks chunk
           WHERE job.project_id=$2
             AND job.job_type='embed_chunk'
             AND job.payload->>'chunkId'=chunk.id::text
             AND chunk.project_id=$2
             AND chunk.snapshot_id=$1
             AND NOT EXISTS (
               SELECT 1 FROM project_knowledge.source_evidence evidence
               WHERE evidence.metadata->>'ref' = 'chunk:'||chunk.id::text
             )`,
          [snapshot.id, lockedSnapshot.project_id],
        );
        const deletedSymbols = await client.query(
          'DELETE FROM project_knowledge.code_symbols WHERE snapshot_id=$1',
          [snapshot.id],
        );
        const deletedChunks = await client.query<{
          deleted_count: number | string;
          kept_evidence_chunks: number | string;
        }>(
          `WITH evidence_chunks AS MATERIALIZED (
             SELECT chunk.id
             FROM project_knowledge.search_chunks chunk
             WHERE chunk.project_id=$2
               AND chunk.snapshot_id=$1
               AND EXISTS (
                 SELECT 1 FROM project_knowledge.source_evidence evidence
                 WHERE evidence.metadata->>'ref' = 'chunk:'||chunk.id::text
               )
           ), deleted AS (
             DELETE FROM project_knowledge.search_chunks chunk
             WHERE chunk.project_id=$2
               AND chunk.snapshot_id=$1
               AND NOT EXISTS (
                 SELECT 1 FROM project_knowledge.source_evidence evidence
                 WHERE evidence.metadata->>'ref' = 'chunk:'||chunk.id::text
               )
             RETURNING chunk.id
           )
           SELECT (SELECT count(*) FROM deleted) AS deleted_count,
                  (SELECT count(*) FROM evidence_chunks) AS kept_evidence_chunks`,
          [snapshot.id, lockedSnapshot.project_id],
        );
        const deletedFiles = await client.query(
          `DELETE FROM project_knowledge.code_files file
           WHERE file.snapshot_id=$1
             AND NOT EXISTS (
               SELECT 1 FROM project_knowledge.code_symbols symbol
               WHERE symbol.file_id=file.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM project_knowledge.source_evidence evidence
               WHERE evidence.snapshot_id=file.snapshot_id
                 AND evidence.source_path=file.repo_relative_path
             )`,
          [snapshot.id],
        );

        await client.query('COMMIT');
        const chunkCounts = deletedChunks.rows[0];
        stats.prunedSnapshots += 1;
        stats.deletedJobs += deletedJobs.rowCount ?? 0;
        stats.deletedSymbols += deletedSymbols.rowCount ?? 0;
        stats.deletedChunks += Number(chunkCounts?.deleted_count ?? 0);
        stats.deletedFiles += deletedFiles.rowCount ?? 0;
        stats.keptEvidenceChunks += Number(
          chunkCounts?.kept_evidence_chunks ?? 0,
        );
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }

    return stats;
  } finally {
    client.release();
  }
}
