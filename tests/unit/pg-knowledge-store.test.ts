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
    item_id: index === 0 ? '10000000-0000-4000-8000-000000000001' : null,
    item_version: index === 0 ? 7 : null,
    stable_key: index === 0 ? 'architecture:authentication' : null,
    metadata: { citation: `result-${index + 1}` },
    documentation_freshness: index === 0 ? 'stale' : null,
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
    expect(result.results[0]).toMatchObject({
      itemId: '10000000-0000-4000-8000-000000000001',
      itemVersion: 7,
      stableKey: 'architecture:authentication',
      documentationFreshness: 'stale',
    });
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

  it('reports stale source freshness when an indexed worktree no longer matches its active snapshot', async () => {
    const pool: PgPoolLike = {
      connect: async () => {
        throw new Error('not used');
      },
      query: async <Row extends Record<string, unknown>>(
        sql: string,
      ): Promise<PgQueryResult<Row>> => {
        if (sql.includes('FROM project_knowledge.projects'))
          return {
            rows: [
              { project_id: 'project-1', db_revision: 4 },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.worktrees'))
          return {
            rows: [
              { id: 'worktree-1', freshness: 'stale' },
            ] as unknown as Row[],
          };
        return { rows: [] };
      },
    };
    const result = await new PgKnowledgeStore(pool).getProjectSyncStatus({
      projectKey: 'MC-Platform',
      changedOnly: true,
    });
    expect(result.sourceFreshness).toBe('stale');
  });

  it('rejects verified completion when the task changed sources linked to stale required documentation', async () => {
    class GateClient extends FakeClient {
      override async query<
        Row extends Record<string, unknown> = Record<string, unknown>,
      >(sql: string): Promise<PgQueryResult<Row>> {
        this.statements.push(sql);
        if (
          sql.includes('FROM project_knowledge.projects') &&
          sql.includes('FOR UPDATE')
        )
          return {
            rows: [
              { project_id: 'project-1', db_revision: 3 },
            ] as unknown as Row[],
          };
        if (sql.includes('task_file_rollups'))
          return {
            rows: [
              {
                ref: 'knowledge:item-1:v2',
                state: 'stale',
              },
            ] as unknown as Row[],
          };
        return { rows: [] };
      }
    }
    const client = new GateClient();
    const store = new PgKnowledgeStore({
      connect: async () => client,
      query: (sql) => client.query(sql),
    });
    await expect(
      store.writeProjectKnowledge({
        projectKey: 'MC-Platform',
        actor: 'codex',
        taskId: 'task-1',
        changes: [
          {
            operation: 'create',
            item: {
              kind: 'work_item',
              title: 'Observer grants',
              deliveryStatus: 'completed',
              verificationStatus: 'source_verified',
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'DOCS_STALE', retryable: false });
    expect(client.statements.at(-1)).toBe('ROLLBACK');
  });

  it('binds source-verified knowledge to validated snapshot evidence', async () => {
    class EvidenceClient extends FakeClient {
      override async query<
        Row extends Record<string, unknown> = Record<string, unknown>,
      >(sql: string): Promise<PgQueryResult<Row>> {
        this.statements.push(sql);
        if (
          sql.includes('FROM project_knowledge.projects') &&
          sql.includes('FOR UPDATE')
        )
          return {
            rows: [
              { project_id: 'project-1', db_revision: 3 },
            ] as unknown as Row[],
          };
        if (sql.includes('knowledge_versions') && sql.includes('RETURNING id'))
          return {
            rows: [{ id: 'version-1' }] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.search_chunks evidence'))
          return {
            rows: [
              {
                id: 'chunk-1',
                worktree_id: 'worktree-1',
                source_path: 'services/observer/server/database.js',
                source_ref: 'connectObserverDatabase',
                source_hash: 'symbol-hash',
              },
            ] as unknown as Row[],
          };
        return { rows: [] };
      }
    }
    const client = new EvidenceClient();
    const store = new PgKnowledgeStore({
      connect: async () => client,
      query: (sql) => client.query(sql),
    });

    await store.writeProjectKnowledge({
      projectKey: 'MC-Platform',
      actor: 'codex',
      changes: [
        {
          operation: 'create',
          evidence: [
            {
              snapshotId: 'snapshot-1',
              ref: 'chunk:chunk-1',
              locatorType: 'symbol',
              required: true,
              verificationScope: 'required',
            },
          ],
          item: {
            kind: 'architecture',
            title: 'Observer database boundary',
            verificationStatus: 'source_verified',
          },
        },
      ],
    });

    expect(
      client.statements.some((sql) =>
        sql.includes('INSERT INTO project_knowledge.source_evidence'),
      ),
    ).toBe(true);
    expect(
      client.statements.some((sql) =>
        sql.includes('INSERT INTO project_knowledge.documentation_freshness'),
      ),
    ).toBe(true);
    expect(client.statements.at(-1)).toBe('COMMIT');
  });

  it('rejects source verification for required documentation without evidence', async () => {
    const client = new FakeClient();
    const store = new PgKnowledgeStore({
      connect: async () => client,
      query: (sql) => client.query(sql),
    });
    await expect(
      store.writeProjectKnowledge({
        projectKey: 'MC-Platform',
        actor: 'codex',
        changes: [
          {
            operation: 'create',
            item: {
              kind: 'api_contract',
              title: 'Observer database API',
              verificationStatus: 'source_verified',
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'DOCS_STALE', retryable: false });
  });
});
