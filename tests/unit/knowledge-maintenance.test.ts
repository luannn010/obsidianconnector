import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  runMaintenance,
  type MaintenanceDependencies,
} from '../../src/worker/knowledge-maintenance.js';

interface QueryCall {
  sql: string;
  values?: unknown[];
}

function maintenanceHarness(
  queryResult?: (sql: string, values?: unknown[]) => Record<string, unknown>,
) {
  const queries: QueryCall[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      return queryResult?.(sql, values) ?? { rows: [], rowCount: 0 };
    },
    release: vi.fn(),
  };
  const output: Array<Record<string, unknown>> = [];
  const diagnostics: string[] = [];
  const dependencies: MaintenanceDependencies = {
    model: { name: 'test-model', revision: 'r1', dimensions: 3 },
    prune: vi.fn(async () => ({
      eligibleSnapshots: 0,
      prunedSnapshots: 0,
      deletedJobs: 0,
      deletedSymbols: 0,
      deletedChunks: 0,
      deletedFiles: 0,
      keptEvidenceChunks: 0,
    })),
    stdout: (value) => output.push(JSON.parse(value)),
    stderr: (value) => diagnostics.push(value),
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    client,
    queries,
    output,
    diagnostics,
    dependencies,
  };
}

describe('knowledge maintenance', () => {
  it('keeps the default dry run read-only', async () => {
    const harness = maintenanceHarness((sql) => {
      if (sql.includes('AS total_chunks'))
        return { rows: [{ total_chunks: '0', superseded_chunks: '0' }] };
      if (sql.includes('GROUP BY chunk.kind')) return { rows: [] };
      if (sql.includes('AS orphan_chunks'))
        return { rows: [{ orphan_chunks: '0' }] };
      if (sql.includes('GROUP BY job.state')) return { rows: [] };
      if (sql.includes('AS cache_rows')) return { rows: [{ cache_rows: '0' }] };
      if (sql.includes('AS eligible_snapshots'))
        return { rows: [{ eligible_snapshots: '0', chunk_rows: '0' }] };
      if (sql.includes('AS completed_jobs'))
        return {
          rows: [
            {
              completed_jobs: '0',
              superseded_jobs: '0',
              deleted_jobs: '0',
              orphan_chunks: '0',
            },
          ],
        };
      return { rows: [], rowCount: 0 };
    });

    await runMaintenance(harness.pool, {}, harness.dependencies);

    expect(
      harness.queries.filter(({ sql }) =>
        /\b(?:INSERT|UPDATE|DELETE|VACUUM|REINDEX)\b/iu.test(sql),
      ),
    ).toEqual([]);
    expect(harness.output.map(({ step }) => step)).toEqual([
      'report',
      'backfill_cache',
      'prune',
      'repair',
      'vacuum',
    ]);
    expect(harness.client.release).toHaveBeenCalledOnce();
  });

  it('backfills only normalized texts within the limit using conflict-safe inserts', async () => {
    let page = 0;
    const harness = maintenanceHarness((sql) => {
      if (sql.includes('SELECT chunk.id,chunk.content,chunk.embedding')) {
        page += 1;
        return page === 1
          ? {
              rows: [
                { id: 'chunk-1', content: 'short text', embedding: '[1,2,3]' },
                {
                  id: 'chunk-2',
                  content: 'x'.repeat(1501),
                  embedding: '[4,5,6]',
                },
              ],
            }
          : { rows: [] };
      }
      if (sql.includes('INSERT INTO project_knowledge.embedding_cache'))
        return { rows: [{ text_hash: 'stored' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await runMaintenance(
      harness.pool,
      { apply: true, skipVacuum: true, maxBatches: 1 },
      harness.dependencies,
    );

    const insert = harness.queries.find(({ sql }) =>
      sql.includes('INSERT INTO project_knowledge.embedding_cache'),
    );
    expect(insert?.sql).toContain(
      'ON CONFLICT(model_key,text_hash) DO NOTHING',
    );
    expect(insert?.values?.[1]).toHaveLength(1);
    const update = harness.queries.find(({ sql }) =>
      sql.includes('UPDATE project_knowledge.search_chunks'),
    );
    expect(update?.values?.[0]).toEqual(['chunk-1']);
    expect(
      harness.output.find(({ step }) => step === 'backfill_cache'),
    ).toMatchObject({
      scannedChunks: 2,
      skippedLongTexts: 1,
      eligibleChunks: 1,
      insertedCacheRows: 1,
      updatedChunkHashes: 0,
    });
  });

  it('stops the prune loop when a batch prunes no snapshots', async () => {
    const harness = maintenanceHarness();
    const prune = vi
      .fn<MaintenanceDependencies['prune']>()
      .mockResolvedValueOnce({
        eligibleSnapshots: 1,
        prunedSnapshots: 1,
        deletedJobs: 2,
        deletedSymbols: 3,
        deletedChunks: 4,
        deletedFiles: 5,
        keptEvidenceChunks: 6,
      })
      .mockResolvedValueOnce({
        eligibleSnapshots: 0,
        prunedSnapshots: 0,
        deletedJobs: 0,
        deletedSymbols: 0,
        deletedChunks: 0,
        deletedFiles: 0,
        keptEvidenceChunks: 0,
      });
    harness.dependencies.prune = prune;

    await runMaintenance(
      harness.pool,
      { apply: true, skipVacuum: true, maxBatches: 50 },
      harness.dependencies,
    );

    expect(prune).toHaveBeenCalledTimes(2);
    expect(prune).toHaveBeenCalledWith(harness.pool, {
      retentionDays: 2,
      maxSnapshots: 5,
    });
    expect(harness.output.find(({ step }) => step === 'prune')).toMatchObject({
      batches: 2,
      prunedSnapshots: 1,
      deletedChunks: 4,
    });
  });

  it('re-enqueues only non-symbol orphan chunks', async () => {
    const harness = maintenanceHarness();

    await runMaintenance(
      harness.pool,
      { apply: true, skipVacuum: true, maxBatches: 1 },
      harness.dependencies,
    );

    const repair = harness.queries.find(({ sql }) =>
      sql.includes('INSERT INTO project_knowledge.outbox_jobs'),
    );
    expect(repair?.sql).toContain("chunk.kind<>'symbol'");
    expect(repair?.sql).toContain("job.job_key='embed:'||chunk.id::text");
    expect(repair?.sql).toContain('LIMIT 1000');
    expect(repair?.sql).toContain('ON CONFLICT DO NOTHING');
  });

  it('skips vacuum and prints commands when no migration URL is available', async () => {
    const harness = maintenanceHarness();

    await runMaintenance(harness.pool, { apply: true }, harness.dependencies);

    expect(harness.diagnostics.join('\n')).toContain(
      'VACUUM (ANALYZE) project_knowledge.search_chunks',
    );
    expect(harness.diagnostics.join('\n')).toContain(
      'REINDEX INDEX CONCURRENTLY project_knowledge.search_chunks_embedding_hnsw',
    );
    expect(harness.output.at(-1)).toEqual({
      step: 'vacuum',
      skipped: true,
      reason: 'migration_database_url_unset',
    });
  });
});
