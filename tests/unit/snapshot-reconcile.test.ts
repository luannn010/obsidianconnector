import { describe, expect, it } from 'vitest';
import { embeddingHash } from '../../src/knowledge/embed-text.js';
import {
  appendIndexablePreviousDirtyPaths,
  clearChangedSnapshotRows,
  SOURCE_PARSER_REVISION,
  sourceChunkEmbeddingPolicy,
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

  it('applies the structural-v3 embedding policy and worktree priority penalty', () => {
    expect(SOURCE_PARSER_REVISION).toBe('structural-v3');
    expect(
      sourceChunkEmbeddingPolicy('symbol', 'function local() {}', true),
    ).toEqual({ embedHash: null, priority: null });
    expect(
      sourceChunkEmbeddingPolicy('documentation', '# Guide', true),
    ).toEqual({ embedHash: embeddingHash('# Guide'), priority: 50 });
    expect(
      sourceChunkEmbeddingPolicy('documentation', '# Guide', false),
    ).toMatchObject({ priority: 30 });
    expect(
      sourceChunkEmbeddingPolicy('api_endpoint', 'GET /health', true),
    ).toMatchObject({ priority: 40 });
    expect(
      sourceChunkEmbeddingPolicy('database_table', 'CREATE TABLE jobs', true),
    ).toMatchObject({ priority: 40 });
    expect(
      sourceChunkEmbeddingPolicy('file_summary', 'src/jobs.ts', true),
    ).toMatchObject({ priority: 30 });
  });
});
