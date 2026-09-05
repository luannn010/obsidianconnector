import { describe, expect, it } from 'vitest';
import { KnowledgeError } from '../../src/knowledge/errors.js';
import {
  PgKnowledgeStore,
  type PgPoolLike,
  type PgQueryResult,
} from '../../src/knowledge/pg-store.js';

class FakeClient {
  readonly statements: string[] = [];
  released = false;
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): Promise<PgQueryResult<Row>> {
    this.statements.push(sql);
    if (
      sql.includes('FROM project_knowledge.projects') &&
      sql.includes('FOR UPDATE')
    ) {
      return {
        rows: [{ project_id: 'project-1', db_revision: 3 }] as unknown as Row[],
      };
    }
    return { rows: [] };
  }
  release(): void {
    this.released = true;
  }
}

describe('PostgreSQL knowledge store', () => {
  it('rolls back a batch when the expected project revision is stale', async () => {
    const client = new FakeClient();
    const pool: PgPoolLike = {
      connect: async () => client,
      query: (sql) => client.query(sql),
    };
    const store = new PgKnowledgeStore(pool);

    await expect(
      store.writeProjectKnowledge({
        projectKey: 'MC-Platform',
        actor: 'codex',
        expectedProjectRevision: 2,
        changes: [
          { operation: 'create', item: { kind: 'decision', title: 'Use SQL' } },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      retryable: false,
    } satisfies Partial<KnowledgeError>);

    expect(client.statements[0]).toBe('BEGIN');
    expect(client.statements.at(-1)).toBe('ROLLBACK');
    expect(client.released).toBe(true);
  });
});
