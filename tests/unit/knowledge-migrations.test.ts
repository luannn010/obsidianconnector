import { describe, expect, it } from 'vitest';
import { knowledgeMigrations } from '../../src/knowledge/migrations.js';
import {
  applyKnowledgeMigrations,
  type PgQueryResult,
} from '../../src/knowledge/pg-store.js';

describe('project knowledge migrations', () => {
  it('defines the isolated schema, migration ledger, and required table families', () => {
    const sql = knowledgeMigrations
      .map((migration) => migration.sql)
      .join('\n');
    for (const table of [
      'projects',
      'repositories',
      'worktrees',
      'source_snapshots',
      'knowledge_items',
      'knowledge_versions',
      'api_endpoints',
      'sequence_flows',
      'documented_tables',
      'physical_mappings',
      'code_symbols',
      'search_chunks',
      'note_projections',
      'outbox_jobs',
      'legacy_sources',
      'agent_tasks',
      'file_activity_events',
      'task_file_rollups',
      'documentation_freshness',
      'domain_path_rules',
      'domain_sync_states',
      'worker_health',
    ]) {
      expect(sql).toContain(`project_knowledge.${table}`);
    }
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_search');
    expect(sql).toContain('embedding vector(384)');
    expect(sql).not.toContain('embedding vector(1024)');
    expect(sql).toContain('project_id uuid NOT NULL');
    expect(sql).toContain('checksum text NOT NULL');
    expect(sql).toContain('source_snapshots_one_active_worktree');
    expect(sql).toContain('outbox_jobs_claimable');
    expect(sql).toContain('note_projections_output_path');
    expect(sql).toContain('file_activity_events_dedupe');
    expect(sql).toContain('documentation_freshness_lookup');
    expect(sql).toContain('domain_sync_states_lookup');
    expect(sql).toContain('dirty_paths text[]');
    expect(sql).toContain('source_snapshot_id');
    expect(sql).toContain('projection_conflicts_one_unresolved_drift');
    expect(sql).toContain('knowledge_version_id');
    expect(sql).toContain('locator_type');
    expect(sql).toContain('parser_revision');
    expect(sql).toContain('finished_at timestamptz');
    expect(sql).toContain("state IN ('pending','failed','processing')");
    expect(sql).toContain('outbox_jobs_one_live_embedding');
    expect(sql).toContain('search_chunks_embedding_reuse');
    expect(sql).toContain('job_key text');
    expect(sql).toContain('required_capability text');
    expect(sql).toContain('parent_job_id uuid');
    expect(sql).toContain('outbox_jobs_one_live_key');
    expect(knowledgeMigrations.at(-1)?.id).toBe('0007_shared_worker_queue');
    expect(sql).toContain('title, project_id, active, snapshot_id');
    for (const exactField of ['path', 'symbol', 'endpoint', 'schema_table']) {
      expect(sql).toContain(`lower(metadata->>'${exactField}')) WHERE active`);
    }
  });

  it('skips an applied migration only when its checksum matches', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const migration = { id: 'm1', sql: 'SELECT 1' };
    let storedChecksum: string | undefined;
    const client = {
      async query<
        Row extends Record<string, unknown> = Record<string, unknown>,
      >(sql: string, values?: unknown[]): Promise<PgQueryResult<Row>> {
        statements.push({ sql, values });
        if (sql.includes('to_regclass')) {
          return { rows: [{ exists: true }] as unknown as Row[] };
        }
        if (sql.includes('SELECT checksum')) {
          return {
            rows: storedChecksum
              ? ([{ checksum: storedChecksum }] as unknown as Row[])
              : [],
          };
        }
        if (sql.includes('INSERT INTO project_knowledge.schema_migrations')) {
          storedChecksum = String(values?.[1]);
        }
        return { rows: [] };
      },
      release() {},
    };
    const pool = { connect: async () => client, query: client.query };

    await applyKnowledgeMigrations(pool, [migration]);
    const firstSqlApplications = statements.filter(
      (entry) => entry.sql === migration.sql,
    ).length;
    await applyKnowledgeMigrations(pool, [migration]);

    expect(firstSqlApplications).toBe(1);
    expect(
      statements.filter((entry) => entry.sql === migration.sql),
    ).toHaveLength(1);
  });

  it('rejects migration checksum drift before applying SQL', async () => {
    const migration = { id: 'm1', sql: 'SELECT dangerous_change()' };
    const statements: string[] = [];
    const client = {
      async query<
        Row extends Record<string, unknown> = Record<string, unknown>,
      >(sql: string): Promise<PgQueryResult<Row>> {
        statements.push(sql);
        if (sql.includes('to_regclass')) {
          return { rows: [{ exists: true }] as unknown as Row[] };
        }
        if (sql.includes('SELECT checksum')) {
          return { rows: [{ checksum: 'different' }] as unknown as Row[] };
        }
        return { rows: [] };
      },
      release() {},
    };

    await expect(
      applyKnowledgeMigrations(
        { connect: async () => client, query: client.query },
        [migration],
      ),
    ).rejects.toThrow('checksum');
    expect(statements).not.toContain(migration.sql);
  });
});
