import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { pruneSupersededSnapshots } from '../../src/worker/snapshot-cleanup.js';

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
});
