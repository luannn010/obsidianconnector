import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  pruneSupersededSnapshotPayload,
  pruneSupersededSnapshots,
} from '../../src/worker/snapshot-cleanup.js';

describe('superseded snapshot cleanup', () => {
  it('protects referenced snapshots and deletes eligible dependencies in order', async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('SELECT snapshot.id')) return { rows: [{ id: 'snapshot-1' }] };
        if (sql.includes('DELETE FROM project_knowledge.source_snapshots'))
          return { rows: [{ id: 'snapshot-1' }] };
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const result = await pruneSupersededSnapshots(
      { connect: async () => client } as unknown as Pool,
      'MC-Platform',
      7,
    );

    const selection = statements.find((sql) => sql.includes('SELECT snapshot.id'))!;
    for (const reference of [
      'source_evidence',
      'agent_tasks',
      'file_activity_events',
      'note_projections',
      'domain_sync_states',
    ]) expect(selection).toContain(reference);
    expect(result.deletedSnapshots).toBe(1);
    expect(statements.findIndex((sql) => sql.includes('code_symbols')))
      .toBeLessThan(statements.findIndex((sql) => sql.includes('code_files')));
  });

  it('prunes payloads in one transaction per snapshot while preserving evidence', async () => {
    const statements: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        statements.push({ sql, params });
        if (sql.includes('ORDER BY COALESCE') && sql.includes('LIMIT')) {
          return {
            rows: [
              { id: 'snapshot-1', project_id: 'project-1' },
              { id: 'snapshot-2', project_id: 'project-2' },
            ],
          };
        }
        if (sql.includes('FOR UPDATE OF snapshot SKIP LOCKED')) {
          return {
            rows: [{
              id: params?.[0],
              project_id: params?.[0] === 'snapshot-1' ? 'project-1' : 'project-2',
            }],
          };
        }
        if (sql.includes('DELETE FROM project_knowledge.outbox_jobs')) {
          return { rows: [], rowCount: 2 };
        }
        if (sql.includes('DELETE FROM project_knowledge.code_symbols')) {
          return { rows: [], rowCount: 3 };
        }
        if (sql.includes('DELETE FROM project_knowledge.search_chunks')) {
          return {
            rows: [{ deleted_count: '4', kept_evidence_chunks: '1' }],
            rowCount: 1,
          };
        }
        if (sql.includes('DELETE FROM project_knowledge.code_files')) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: vi.fn(),
    };

    const result = await pruneSupersededSnapshotPayload(
      { connect: async () => client } as unknown as Pool,
      { retentionDays: 2, maxSnapshots: 10 },
    );

    expect(result).toEqual({
      eligibleSnapshots: 2,
      prunedSnapshots: 2,
      deletedJobs: 4,
      deletedSymbols: 6,
      deletedChunks: 8,
      deletedFiles: 2,
      keptEvidenceChunks: 2,
    });
    expect(statements.filter(({ sql }) => sql === 'BEGIN')).toHaveLength(2);
    expect(statements.filter(({ sql }) => sql === 'COMMIT')).toHaveLength(2);

    const selection = statements.find(({ sql }) =>
      sql.includes('ORDER BY COALESCE'),
    )!.sql;
    expect(selection).not.toContain('project.project_key');
    expect(selection).toContain('EXISTS');
    expect(selection).toContain(
      "evidence.metadata->>'ref' = 'chunk:'||chunk.id::text",
    );
    expect(selection).toMatch(
      /search_chunks chunk[\s\S]+NOT EXISTS \([\s\S]+source_evidence evidence/,
    );
    expect(selection).toContain('SELECT snapshot.id,snapshot.project_id');
    expect(selection).toContain('chunk.project_id=snapshot.project_id');

    const locks = statements.filter(({ sql }) =>
      sql.includes('FOR UPDATE OF snapshot SKIP LOCKED'),
    );
    expect(locks).toHaveLength(2);
    for (const lock of locks) {
      expect(lock.sql).toContain('SELECT snapshot.id,snapshot.project_id');
      expect(lock.sql).toContain('chunk.project_id=snapshot.project_id');
    }

    const firstJobDelete = statements.findIndex(({ sql }) =>
      sql.includes('DELETE FROM project_knowledge.outbox_jobs'),
    );
    const firstSymbolDelete = statements.findIndex(({ sql }) =>
      sql.includes('DELETE FROM project_knowledge.code_symbols'),
    );
    const firstChunkDelete = statements.findIndex(({ sql }) =>
      sql.includes('DELETE FROM project_knowledge.search_chunks'),
    );
    const firstFileDelete = statements.findIndex(({ sql }) =>
      sql.includes('DELETE FROM project_knowledge.code_files'),
    );
    expect(firstJobDelete).toBeLessThan(firstSymbolDelete);
    expect(firstSymbolDelete).toBeLessThan(firstChunkDelete);
    expect(firstChunkDelete).toBeLessThan(firstFileDelete);

    const jobDelete = statements[firstJobDelete]!;
    const chunkDelete = statements[firstChunkDelete]!;
    expect(jobDelete.sql).toContain(
      'USING project_knowledge.search_chunks chunk',
    );
    expect(jobDelete.sql).toContain('job.project_id=$2');
    expect(jobDelete.sql).toContain('chunk.project_id=$2');
    expect(jobDelete.sql).toContain('chunk.snapshot_id=$1');
    expect(jobDelete.params).toEqual(['snapshot-1', 'project-1']);
    expect(chunkDelete.sql.match(/chunk\.project_id=\$2/g)).toHaveLength(2);
    expect(chunkDelete.params).toEqual(['snapshot-1', 'project-1']);
    expect(jobDelete.sql).toContain(
      "evidence.metadata->>'ref' = 'chunk:'||chunk.id::text",
    );
    expect(chunkDelete.sql).toContain(
      "evidence.metadata->>'ref' = 'chunk:'||chunk.id::text",
    );
    expect(
      statements.some(({ sql }) =>
        sql.includes('DELETE FROM project_knowledge.source_snapshots'),
      ),
    ).toBe(false);
    expect(
      statements.some(({ sql }) =>
        sql.includes('DELETE FROM project_knowledge.documentation_freshness'),
      ),
    ).toBe(false);
  });

  it('adds a project filter only when payload cleanup is scoped to a project', async () => {
    const statements: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        statements.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
      release: vi.fn(),
    };

    await pruneSupersededSnapshotPayload(
      { connect: async () => client } as unknown as Pool,
      { projectKey: 'MC-Platform' },
    );

    const selection = statements.find(({ sql }) =>
      sql.includes('ORDER BY COALESCE'),
    )!;
    expect(selection.sql).toContain('project.project_key=$3');
    expect(selection.params).toEqual([2, 10, 'MC-Platform']);
  });

  it('rolls back only the failing snapshot after earlier snapshots commit', async () => {
    const statements: string[] = [];
    let symbolDeletes = 0;
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        statements.push(sql);
        if (sql.includes('ORDER BY COALESCE') && sql.includes('LIMIT')) {
          return {
            rows: [
              { id: 'snapshot-1', project_id: 'project-1' },
              { id: 'snapshot-2', project_id: 'project-2' },
            ],
          };
        }
        if (sql.includes('FOR UPDATE OF snapshot SKIP LOCKED')) {
          return {
            rows: [{
              id: params?.[0],
              project_id: params?.[0] === 'snapshot-1' ? 'project-1' : 'project-2',
            }],
          };
        }
        if (sql.includes('DELETE FROM project_knowledge.code_symbols')) {
          symbolDeletes += 1;
          if (symbolDeletes === 2) throw new Error('symbol deletion failed');
        }
        if (sql.includes('DELETE FROM project_knowledge.search_chunks')) {
          return {
            rows: [{ deleted_count: '1', kept_evidence_chunks: '0' }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };

    await expect(
      pruneSupersededSnapshotPayload(
        { connect: async () => client } as unknown as Pool,
        {},
      ),
    ).rejects.toThrow('symbol deletion failed');

    expect(statements.filter((sql) => sql === 'BEGIN')).toHaveLength(2);
    expect(statements.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
    expect(statements.filter((sql) => sql === 'ROLLBACK')).toHaveLength(1);
    expect(statements.indexOf('COMMIT')).toBeLessThan(
      statements.lastIndexOf('BEGIN'),
    );
    expect(client.release).toHaveBeenCalledOnce();
  });
});
