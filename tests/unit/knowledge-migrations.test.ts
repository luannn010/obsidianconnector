import { describe, expect, it } from 'vitest';
import { knowledgeMigrations } from '../../src/knowledge/migrations.js';

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
    ]) {
      expect(sql).toContain(`project_knowledge.${table}`);
    }
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_search');
    expect(sql).toContain('project_id uuid NOT NULL');
  });
});
