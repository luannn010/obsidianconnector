import { describe, expect, it } from 'vitest';
import {
  appendIndexablePreviousDirtyPaths,
  clearChangedSnapshotRows,
} from '../../src/worker/knowledge-worker.js';

describe('snapshot changed-file cleanup', () => {
  it('deletes dependent symbols before their code files', async () => {
    const statements: string[] = [];
    await clearChangedSnapshotRows(
      {
        query: async (sql: string) => {
          statements.push(sql);
          return { rows: [] };
        },
      },
      'snapshot-1',
      ['services/observer/server/database.js'],
    );

    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain(
      'DELETE FROM project_knowledge.code_symbols',
    );
    expect(statements[1]).toContain(
      'DELETE FROM project_knowledge.search_chunks',
    );
    expect(statements[2]).toContain('DELETE FROM project_knowledge.code_files');
  });

  it('does not reintroduce stale binary or secret paths as indexable changes', () => {
    const changes = [{ status: 'A', path: 'src/current.ts' }];

    appendIndexablePreviousDirtyPaths(changes, [
      'apps/mobile/assets/icon.png',
      '.env.local',
      'src/previous.ts',
    ]);

    expect(changes).toEqual([
      { status: 'A', path: 'src/current.ts' },
      { status: 'M', path: 'src/previous.ts' },
    ]);
  });
});
