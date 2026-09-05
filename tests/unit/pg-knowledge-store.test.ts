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

function searchPool(count: number): PgPoolLike {
  const chunks = Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    kind: 'architecture',
    title: `Result ${index + 1}`,
    content: `Architecture result ${index + 1}`,
    content_hash: `hash-${index + 1}`,
    metadata: { citation: `result-${index + 1}` },
    head_commit: null,
    db_revision: 4,
  }));
  return {
    connect: async () => {
      throw new Error('not used by search');
    },
    query: async <
      Row extends Record<string, unknown> = Record<string, unknown>,
    >(
      sql: string,
    ): Promise<PgQueryResult<Row>> => {
      if (sql.includes('FROM project_knowledge.projects'))
        return {
          rows: [
            { project_id: 'project-1', db_revision: 4 },
          ] as unknown as Row[],
        };
      return { rows: chunks as unknown as Row[] };
    },
  };
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

  it('does not rerank exact lookup results', async () => {
    const store = new PgKnowledgeStore(searchPool(2), {
      rerankerEnabled: true,
      reranker: {
        rerank: async (_query, hits) => [...hits].reverse(),
      },
    });

    const result = await store.searchProjectContext({
      projectKey: 'MC-Platform',
      query: 'GET /api/servers',
      mode: 'exact',
      limit: 2,
      maxTokens: 2000,
    });

    expect(result.results.map((hit) => hit.title)).toEqual([
      'Result 1',
      'Result 2',
    ]);
  });

  it('falls back to BM25 and reranks only the leading hybrid candidates when embeddings are unavailable', async () => {
    const store = new PgKnowledgeStore(searchPool(25), {
      embedder: {
        embed: async () => {
          throw new KnowledgeError('EMBEDDING_UNAVAILABLE', 'offline', true);
        },
      },
      rerankerEnabled: true,
      reranker: {
        rerank: async (_query, hits) => [...hits].reverse(),
      },
    });

    const result = await store.searchProjectContext({
      projectKey: 'MC-Platform',
      query: 'allocation ownership lifecycle',
      mode: 'hybrid',
      limit: 6,
      maxTokens: 4000,
    });

    expect(result.results[0]?.title).toBe('Result 20');
    expect(result.results).toHaveLength(6);
    expect(result.warnings).toEqual([
      'Semantic retrieval unavailable; BM25 results returned',
    ]);
  });
});
