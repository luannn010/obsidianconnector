import { Client, type Pool, type PoolClient, type QueryResult } from 'pg';
import {
  EMBEDDABLE_CHUNK_KINDS,
  EMBEDDING_TEXT_LIMIT,
  embeddingHash,
  embeddingModelKey,
  normalizeEmbeddingText,
  type EmbeddingModelKeyInput,
} from '../knowledge/embed-text.js';
import {
  pruneSupersededSnapshotPayload,
  type SnapshotPayloadCleanupStats,
} from './snapshot-cleanup.js';

export interface MaintenanceOptions {
  apply?: boolean;
  skipVacuum?: boolean;
  retentionDays?: number;
  maxBatches?: number;
}

interface VacuumClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface MaintenanceDependencies {
  model: EmbeddingModelKeyInput;
  migrationDatabaseUrl?: string;
  prune: (
    pool: Pool,
    options: { retentionDays: number; maxSnapshots: number },
  ) => Promise<SnapshotPayloadCleanupStats>;
  createVacuumClient?: (connectionString: string) => VacuumClient;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

interface BackfillRow {
  id: string;
  content: string;
  embedding: unknown;
}

interface CountRow {
  [key: string]: number | string | null | undefined;
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function writeJson(
  dependencies: MaintenanceDependencies,
  value: Record<string, unknown>,
): void {
  dependencies.stdout(JSON.stringify(value));
}

async function report(
  client: PoolClient,
  modelKey: string,
): Promise<Record<string, unknown>> {
  const totals = (
    await client.query<CountRow>(
      `SELECT count(*) AS total_chunks,
              count(*) FILTER (
                WHERE snapshot.state='superseded'
              ) AS superseded_chunks
       FROM project_knowledge.search_chunks chunk
       LEFT JOIN project_knowledge.source_snapshots snapshot
         ON snapshot.id=chunk.snapshot_id`,
    )
  ).rows[0];
  const payload = (
    await client.query<CountRow>(
      `SELECT count(*) AS superseded_snapshots_with_payload
       FROM project_knowledge.source_snapshots snapshot
       WHERE snapshot.state='superseded'
         AND (
           EXISTS (
             SELECT 1 FROM project_knowledge.search_chunks chunk
             WHERE chunk.snapshot_id=snapshot.id
               AND chunk.project_id=snapshot.project_id
           )
           OR EXISTS (
             SELECT 1 FROM project_knowledge.code_symbols symbol
             WHERE symbol.snapshot_id=snapshot.id
           )
         )`,
    )
  ).rows[0];
  const kinds = await client.query<{ kind: string; count: number | string }>(
    `SELECT chunk.kind,count(*) AS count
     FROM project_knowledge.search_chunks chunk
     LEFT JOIN project_knowledge.source_snapshots snapshot
       ON snapshot.id=chunk.snapshot_id
     WHERE chunk.active
       AND (chunk.snapshot_id IS NULL OR snapshot.state='active')
     GROUP BY chunk.kind ORDER BY chunk.kind`,
  );
  const orphan = (
    await client.query<CountRow>(
      `SELECT count(*) AS orphan_chunks
       FROM project_knowledge.search_chunks chunk
       LEFT JOIN project_knowledge.source_snapshots snapshot
         ON snapshot.id=chunk.snapshot_id
       WHERE chunk.active AND chunk.embedding IS NULL
         AND (chunk.snapshot_id IS NULL OR snapshot.state='active')
         AND chunk.kind<>'symbol'
         AND (chunk.snapshot_id IS NULL OR chunk.kind=ANY($1::text[]))
         AND NOT EXISTS (
           SELECT 1 FROM project_knowledge.outbox_jobs job
           WHERE job.project_id=chunk.project_id
             AND job.job_type='embed_chunk'
             AND job.job_key='embed:'||chunk.id::text
             AND job.state IN ('pending','failed','processing')
         )`,
      [[...EMBEDDABLE_CHUNK_KINDS]],
    )
  ).rows[0];
  const jobs = await client.query<{ state: string; count: number | string }>(
    `SELECT job.state,count(*) AS count
     FROM project_knowledge.outbox_jobs job
     WHERE job.job_type='embed_chunk'
     GROUP BY job.state ORDER BY job.state`,
  );
  const cache = (
    await client.query<CountRow>(
      `SELECT count(*) AS cache_rows
       FROM project_knowledge.embedding_cache
       WHERE model_key=$1`,
      [modelKey],
    )
  ).rows[0];
  return {
    step: 'report',
    totalChunks: numeric(totals?.total_chunks),
    supersededChunks: numeric(totals?.superseded_chunks),
    activeChunksByKind: Object.fromEntries(
      kinds.rows.map((row) => [row.kind, numeric(row.count)]),
    ),
    orphanChunks: numeric(orphan?.orphan_chunks),
    embedJobsByState: Object.fromEntries(
      jobs.rows.map((row) => [row.state, numeric(row.count)]),
    ),
    currentModelCacheRows: numeric(cache?.cache_rows),
    supersededSnapshotsWithPayload: numeric(
      payload?.superseded_snapshots_with_payload,
    ),
  };
}

async function backfillCache(
  client: PoolClient,
  apply: boolean,
  model: EmbeddingModelKeyInput,
): Promise<Record<string, unknown>> {
  const modelKey = embeddingModelKey(model);
  const knownHashes = new Set<string>();
  let cursor: string | null = null;
  let scannedChunks = 0;
  let skippedLongTexts = 0;
  let eligibleChunks = 0;
  let wouldInsertCacheRows = 0;
  let insertedCacheRows = 0;
  let updatedChunkHashes = 0;

  while (true) {
    const page: QueryResult<BackfillRow> = await client.query<BackfillRow>(
      `SELECT chunk.id,chunk.content,chunk.embedding
       FROM project_knowledge.search_chunks chunk
       JOIN project_knowledge.embedding_models model
         ON model.id=chunk.embedding_model_id
       LEFT JOIN project_knowledge.source_snapshots snapshot
         ON snapshot.id=chunk.snapshot_id
       WHERE chunk.active AND chunk.embedding IS NOT NULL
         AND (chunk.snapshot_id IS NULL OR snapshot.state='active')
         AND (chunk.snapshot_id IS NULL OR chunk.kind=ANY($1::text[]))
         AND model.model_name=$2 AND model.model_revision=$3
         AND model.dimensions=$4
         AND ($5::uuid IS NULL OR chunk.id>$5::uuid)
       ORDER BY chunk.id LIMIT 500`,
      [
        [...EMBEDDABLE_CHUNK_KINDS],
        model.name,
        model.revision,
        model.dimensions,
        cursor,
      ],
    );
    if (page.rows.length === 0) break;
    scannedChunks += page.rows.length;
    cursor = page.rows.at(-1)!.id;

    const eligible: Array<BackfillRow & { hash: string }> = page.rows.flatMap(
      (row): Array<BackfillRow & { hash: string }> => {
        if (normalizeEmbeddingText(row.content).length > EMBEDDING_TEXT_LIMIT) {
          skippedLongTexts += 1;
          return [];
        }
        return [{ ...row, hash: embeddingHash(row.content) }];
      },
    );
    eligibleChunks += eligible.length;
    if (eligible.length === 0) continue;

    const hashes = [...new Set(eligible.map(({ hash }) => hash))].filter(
      (hash) => !knownHashes.has(hash),
    );
    if (!apply && hashes.length > 0) {
      const existing = await client.query<{ text_hash: string }>(
        `SELECT text_hash
         FROM project_knowledge.embedding_cache
         WHERE model_key=$1 AND text_hash::text=ANY($2::text[])`,
        [modelKey, hashes],
      );
      const existingHashes = new Set(
        existing.rows.map(({ text_hash }) => text_hash.trim()),
      );
      wouldInsertCacheRows += hashes.filter(
        (hash) => !existingHashes.has(hash),
      ).length;
    }

    if (apply) {
      const representatives = [
        ...new Map(eligible.map((row) => [row.hash, row])).values(),
      ].filter(({ hash }) => !knownHashes.has(hash));
      if (representatives.length > 0) {
        const inserted = await client.query<{ text_hash: string }>(
          `INSERT INTO project_knowledge.embedding_cache
             (model_key,text_hash,embedding)
           SELECT $1,value.text_hash::char(64),value.embedding::vector
           FROM unnest($2::text[],$3::text[])
             AS value(text_hash,embedding)
           ON CONFLICT(model_key,text_hash) DO NOTHING
           RETURNING text_hash`,
          [
            modelKey,
            representatives.map(({ hash }) => hash),
            representatives.map(({ embedding }) => String(embedding)),
          ],
        );
        insertedCacheRows += inserted.rowCount ?? inserted.rows.length;
      }
      const updated = await client.query(
        `UPDATE project_knowledge.search_chunks chunk
         SET embed_hash=value.text_hash
         FROM unnest($1::uuid[],$2::char(64)[]) AS value(id,text_hash)
         WHERE chunk.id=value.id AND chunk.embed_hash IS NULL`,
        [eligible.map(({ id }) => id), eligible.map(({ hash }) => hash)],
      );
      updatedChunkHashes += updated.rowCount ?? 0;
    }
    hashes.forEach((hash) => knownHashes.add(hash));
  }

  return {
    step: 'backfill_cache',
    applied: apply,
    scannedChunks,
    skippedLongTexts,
    eligibleChunks,
    ...(apply
      ? { insertedCacheRows, updatedChunkHashes }
      : { wouldInsertCacheRows }),
  };
}

async function dryRunPrune(
  client: PoolClient,
  retentionDays: number,
): Promise<Record<string, unknown>> {
  const row = (
    await client.query<CountRow>(
      `WITH eligible AS MATERIALIZED (
         SELECT snapshot.id,snapshot.project_id
         FROM project_knowledge.source_snapshots snapshot
         WHERE snapshot.state='superseded'
           AND COALESCE(snapshot.activated_at,snapshot.created_at)
             <now()-($1*interval '1 day')
           AND (
             EXISTS (
               SELECT 1 FROM project_knowledge.search_chunks chunk
               WHERE chunk.project_id=snapshot.project_id
                 AND chunk.snapshot_id=snapshot.id
                 AND NOT EXISTS (
                   SELECT 1 FROM project_knowledge.source_evidence evidence
                   WHERE evidence.metadata->>'ref'='chunk:'||chunk.id::text
                 )
             )
             OR EXISTS (
               SELECT 1 FROM project_knowledge.code_symbols symbol
               WHERE symbol.snapshot_id=snapshot.id
             )
           )
       )
       SELECT count(*) AS eligible_snapshots,
              (SELECT count(*)
               FROM project_knowledge.search_chunks chunk
               JOIN eligible ON eligible.id=chunk.snapshot_id
                 AND eligible.project_id=chunk.project_id
               WHERE NOT EXISTS (
                 SELECT 1 FROM project_knowledge.source_evidence evidence
                 WHERE evidence.metadata->>'ref'='chunk:'||chunk.id::text
               )) AS chunk_rows
       FROM eligible`,
      [retentionDays],
    )
  ).rows[0];
  return {
    step: 'prune',
    applied: false,
    eligibleSnapshots: numeric(row?.eligible_snapshots),
    chunkRows: numeric(row?.chunk_rows),
  };
}

async function applyPrune(
  pool: Pool,
  retentionDays: number,
  maxBatches: number,
  dependencies: MaintenanceDependencies,
): Promise<Record<string, unknown>> {
  const totals: SnapshotPayloadCleanupStats = {
    eligibleSnapshots: 0,
    prunedSnapshots: 0,
    deletedJobs: 0,
    deletedSymbols: 0,
    deletedChunks: 0,
    deletedFiles: 0,
    keptEvidenceChunks: 0,
  };
  let batches = 0;
  while (batches < maxBatches) {
    const result = await dependencies.prune(pool, {
      retentionDays,
      maxSnapshots: 5,
    });
    batches += 1;
    for (const key of Object.keys(totals) as Array<keyof typeof totals>)
      totals[key] += result[key];
    if (result.prunedSnapshots === 0) break;
  }
  return { step: 'prune', applied: true, batches, ...totals };
}

async function dryRunRepair(
  client: PoolClient,
): Promise<Record<string, unknown>> {
  const row = (
    await client.query<CountRow>(
      `SELECT
         (SELECT count(*) FROM (
            SELECT job.id
            FROM project_knowledge.outbox_jobs job
            JOIN project_knowledge.search_chunks chunk
              ON chunk.id=(job.payload->>'chunkId')::uuid
            WHERE job.job_type='embed_chunk' AND job.state='processing'
              AND chunk.embedding IS NOT NULL
            LIMIT 1000
          ) candidates) AS completed_jobs,
         (SELECT count(*) FROM (
            SELECT job.id
            FROM project_knowledge.outbox_jobs job
            LEFT JOIN project_knowledge.search_chunks chunk
              ON chunk.id=(job.payload->>'chunkId')::uuid
            WHERE job.job_type='embed_chunk'
              AND job.state IN ('pending','failed','processing')
              AND (chunk.id IS NULL OR NOT chunk.active)
              AND (
                chunk.id IS NULL OR chunk.item_id IS NULL OR chunk.active
              )
            LIMIT 1000
          ) candidates) AS superseded_jobs,
         (SELECT count(*) FROM (
            SELECT job.id
            FROM project_knowledge.outbox_jobs job
            JOIN project_knowledge.search_chunks chunk
              ON chunk.id=(job.payload->>'chunkId')::uuid
            WHERE job.job_type='embed_chunk'
              AND job.state IN ('pending','failed','processing')
              AND chunk.item_id IS NOT NULL AND NOT chunk.active
              AND NOT (
                job.state='processing' AND chunk.embedding IS NOT NULL
              )
            LIMIT 1000
          ) candidates) AS deleted_jobs,
         (SELECT count(*) FROM (
            SELECT chunk.id
            FROM project_knowledge.search_chunks chunk
            LEFT JOIN project_knowledge.source_snapshots snapshot
              ON snapshot.id=chunk.snapshot_id
            WHERE chunk.active AND chunk.embedding IS NULL
              AND (chunk.snapshot_id IS NULL OR snapshot.state='active')
              AND chunk.kind<>'symbol'
              AND (chunk.snapshot_id IS NULL OR chunk.kind=ANY($1::text[]))
              AND NOT EXISTS (
                SELECT 1 FROM project_knowledge.outbox_jobs job
                WHERE job.project_id=chunk.project_id
                  AND job.job_type='embed_chunk'
                  AND job.job_key='embed:'||chunk.id::text
                  AND job.state IN ('pending','failed','processing')
              )
            LIMIT 1000
          ) candidates) AS orphan_chunks`,
      [[...EMBEDDABLE_CHUNK_KINDS]],
    )
  ).rows[0];
  return {
    step: 'repair',
    applied: false,
    wouldCompleteJobs: numeric(row?.completed_jobs),
    wouldSupersedeJobs: numeric(row?.superseded_jobs),
    wouldDeleteJobs: numeric(row?.deleted_jobs),
    wouldReenqueueOrphans: numeric(row?.orphan_chunks),
  };
}

async function applyRepair(
  client: PoolClient,
): Promise<Record<string, unknown>> {
  const completed = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT job.id
       FROM project_knowledge.outbox_jobs job
       JOIN project_knowledge.search_chunks chunk
         ON chunk.id=(job.payload->>'chunkId')::uuid
       WHERE job.job_type='embed_chunk' AND job.state='processing'
         AND chunk.embedding IS NOT NULL
       ORDER BY job.created_at LIMIT 1000
     )
     UPDATE project_knowledge.outbox_jobs job
     SET state='done',finished_at=now(),locked_at=NULL,last_error=NULL,
         resolution=jsonb_build_object('reason','already_embedded')
     FROM candidates WHERE job.id=candidates.id`,
  );
  const deleted = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT job.id
       FROM project_knowledge.outbox_jobs job
       JOIN project_knowledge.search_chunks chunk
         ON chunk.id=(job.payload->>'chunkId')::uuid
       WHERE job.job_type='embed_chunk'
         AND job.state IN ('pending','failed','processing')
         AND chunk.item_id IS NOT NULL AND NOT chunk.active
       ORDER BY job.created_at LIMIT 1000
     )
     DELETE FROM project_knowledge.outbox_jobs job
     USING candidates WHERE job.id=candidates.id`,
  );
  const superseded = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT job.id,CASE WHEN chunk.id IS NULL
         THEN 'missing_chunk' ELSE 'inactive_chunk' END AS reason
       FROM project_knowledge.outbox_jobs job
       LEFT JOIN project_knowledge.search_chunks chunk
         ON chunk.id=(job.payload->>'chunkId')::uuid
       WHERE job.job_type='embed_chunk'
         AND job.state IN ('pending','failed','processing')
         AND (chunk.id IS NULL OR NOT chunk.active)
       ORDER BY job.created_at LIMIT 1000
     )
     UPDATE project_knowledge.outbox_jobs job
     SET state='superseded',finished_at=now(),locked_at=NULL,last_error=NULL,
         resolution=jsonb_build_object('reason',candidates.reason)
     FROM candidates WHERE job.id=candidates.id`,
  );
  const reenqueued = await client.query(
    `WITH orphan_candidates AS MATERIALIZED (
       SELECT chunk.id,chunk.project_id
       FROM project_knowledge.search_chunks chunk
       LEFT JOIN project_knowledge.source_snapshots snapshot
         ON snapshot.id=chunk.snapshot_id
       WHERE chunk.active AND chunk.embedding IS NULL
         AND (chunk.snapshot_id IS NULL OR snapshot.state='active')
         AND chunk.kind<>'symbol'
         AND (chunk.snapshot_id IS NULL OR chunk.kind=ANY($1::text[]))
         AND NOT EXISTS (
           SELECT 1 FROM project_knowledge.outbox_jobs job
           WHERE job.project_id=chunk.project_id
             AND job.job_type='embed_chunk'
             AND job.job_key='embed:'||chunk.id::text
             AND job.state IN ('pending','failed','processing')
         )
       ORDER BY chunk.id LIMIT 1000
     )
     INSERT INTO project_knowledge.outbox_jobs
       (project_id,job_type,job_key,required_capability,payload)
     SELECT project_id,'embed_chunk','embed:'||id::text,'embedding',
            jsonb_build_object('chunkId',id::text)
     FROM orphan_candidates ON CONFLICT DO NOTHING`,
    [[...EMBEDDABLE_CHUNK_KINDS]],
  );
  return {
    step: 'repair',
    applied: true,
    completedJobs: completed.rowCount ?? 0,
    supersededJobs: superseded.rowCount ?? 0,
    deletedJobs: deleted.rowCount ?? 0,
    reenqueuedOrphans: reenqueued.rowCount ?? 0,
  };
}

async function vacuum(
  apply: boolean,
  skipVacuum: boolean,
  dependencies: MaintenanceDependencies,
): Promise<Record<string, unknown>> {
  if (!apply) return { step: 'vacuum', skipped: true, reason: 'dry_run' };
  if (skipVacuum)
    return { step: 'vacuum', skipped: true, reason: 'skip_vacuum' };
  if (!dependencies.migrationDatabaseUrl) {
    dependencies.stderr('VACUUM (ANALYZE) project_knowledge.search_chunks;');
    dependencies.stderr('VACUUM (ANALYZE) project_knowledge.outbox_jobs;');
    dependencies.stderr(
      'REINDEX INDEX CONCURRENTLY project_knowledge.search_chunks_embedding_hnsw;',
    );
    return {
      step: 'vacuum',
      skipped: true,
      reason: 'migration_database_url_unset',
    };
  }
  const createClient =
    dependencies.createVacuumClient ??
    ((connectionString: string) =>
      new Client({ connectionString }) as unknown as VacuumClient);
  const client = createClient(dependencies.migrationDatabaseUrl);
  await client.connect();
  try {
    await client.query('SET statement_timeout = 0');
    await client.query('VACUUM (ANALYZE) project_knowledge.search_chunks');
    await client.query('VACUUM (ANALYZE) project_knowledge.outbox_jobs');
    await client.query(
      'REINDEX INDEX CONCURRENTLY project_knowledge.search_chunks_embedding_hnsw',
    );
  } finally {
    await client.end();
  }
  return { step: 'vacuum', skipped: false };
}

export async function runMaintenance(
  pool: Pool,
  options: MaintenanceOptions = {},
  dependencies: MaintenanceDependencies,
): Promise<void> {
  const apply = options.apply ?? false;
  const skipVacuum = options.skipVacuum ?? false;
  const retentionDays = options.retentionDays ?? 2;
  const maxBatches = options.maxBatches ?? 50;
  const modelKey = embeddingModelKey(dependencies.model);
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '120s'");
    writeJson(dependencies, await report(client, modelKey));
    writeJson(
      dependencies,
      await backfillCache(client, apply, dependencies.model),
    );
    writeJson(
      dependencies,
      apply
        ? await applyPrune(pool, retentionDays, maxBatches, dependencies)
        : await dryRunPrune(client, retentionDays),
    );
    writeJson(
      dependencies,
      apply ? await applyRepair(client) : await dryRunRepair(client),
    );
  } finally {
    client.release();
  }
  writeJson(dependencies, await vacuum(apply, skipVacuum, dependencies));
}

export function defaultMaintenanceDependencies(
  model: EmbeddingModelKeyInput,
  migrationDatabaseUrl?: string,
): MaintenanceDependencies {
  return {
    model,
    migrationDatabaseUrl,
    prune: pruneSupersededSnapshotPayload,
    stdout: (value) => console.log(value),
    stderr: (value) => console.error(value),
  };
}
