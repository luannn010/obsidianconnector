import { describe, expect, it, vi } from 'vitest';
import { KnowledgeError } from '../../src/knowledge/errors.js';
import { canonicalHash } from '../../src/knowledge/hash.js';
import { embeddingHash } from '../../src/knowledge/embed-text.js';
import {
  PgKnowledgeStore,
  type PgClientLike,
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
      sql.includes('FOR NO KEY UPDATE')
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

class KnowledgeWriteClient extends FakeClient {
  readonly queries: Array<{ sql: string; values?: unknown[] }> = [];

  constructor(private readonly existing?: Record<string, unknown>) {
    super();
  }

  override async query<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(sql: string, values?: unknown[]): Promise<PgQueryResult<Row>> {
    this.statements.push(sql);
    this.queries.push({ sql, values });
    if (
      sql.includes('FROM project_knowledge.projects') &&
      sql.includes('FOR NO KEY UPDATE')
    )
      return {
        rows: [{ project_id: 'project-1', db_revision: 3 }] as unknown as Row[],
      };
    if (sql.includes('FOR UPDATE OF i'))
      return {
        rows: this.existing ? ([this.existing] as unknown as Row[]) : [],
      };
    if (sql.includes('INSERT INTO project_knowledge.work_items'))
      return { rows: [{ id: 'work-item-1' }] as unknown as Row[] };
    if (sql.includes('INSERT INTO project_knowledge.knowledge_versions'))
      return { rows: [{ id: 'version-1' }] as unknown as Row[] };
    return { rows: [] };
  }
}

function existingWorkItem(properties: Record<string, unknown>) {
  return {
    id: 'item-1',
    stable_key: 'work_item:claimable',
    kind: 'work_item',
    title: 'Claimable work',
    current_version: 1,
    delivery_status: 'active',
    verification_status: 'unverified',
    domain: null,
    service: null,
    body_markdown: 'Coordinate this work.',
    properties,
    canonical_hash: 'current-hash',
  };
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

interface SyncStatusFixture {
  projectKey?: string;
  dbRevision?: number;
  snapshots?: Array<Record<string, unknown>>;
  projections?: Array<Record<string, unknown>>;
  queues?: Array<Record<string, unknown>>;
  freshness?: Array<Record<string, unknown>>;
  domains?: Array<Record<string, unknown>>;
  evidence?: Array<Record<string, unknown>>;
}

function syncStatusPool(fixture: SyncStatusFixture): PgPoolLike {
  return {
    connect: async () => {
      throw new Error('not used by sync status');
    },
    query: async <Row extends Record<string, unknown>>(
      sql: string,
    ): Promise<PgQueryResult<Row>> => {
      if (sql.includes('FROM project_knowledge.projects'))
        return {
          rows: [
            {
              project_id: fixture.projectKey ?? 'project-status',
              db_revision: fixture.dbRevision ?? 1,
            },
          ] as unknown as Row[],
        };
      if (sql.includes('FROM project_knowledge.worktrees'))
        return { rows: (fixture.snapshots ?? []) as unknown as Row[] };
      if (sql.includes('FROM project_knowledge.note_projections'))
        return { rows: (fixture.projections ?? []) as unknown as Row[] };
      if (sql.includes('FROM project_knowledge.outbox_jobs'))
        return { rows: (fixture.queues ?? []) as unknown as Row[] };
      if (sql.includes('FROM project_knowledge.projection_conflicts'))
        return { rows: [] };
      if (sql.includes('FROM project_knowledge.documentation_freshness'))
        return { rows: (fixture.freshness ?? []) as unknown as Row[] };
      if (sql.includes('FROM project_knowledge.agent_tasks'))
        return { rows: [] };
      if (sql.includes('FROM project_knowledge.domain_sync_states'))
        return { rows: (fixture.domains ?? []) as unknown as Row[] };
      if (sql.includes('FROM project_knowledge.domain_path_rules'))
        return {
          rows: [
            { rule_count: 2, rule_fingerprint: 'rules-v2' },
          ] as unknown as Row[],
        };
      if (sql.includes('source_path=ANY'))
        return { rows: (fixture.evidence ?? []) as unknown as Row[] };
      if (sql.includes('FROM project_knowledge.source_evidence'))
        return {
          rows: [{ evidence_count: 4, mapping_count: 2 }] as unknown as Row[],
        };
      return { rows: [] };
    },
  };
}

describe('PostgreSQL knowledge store', () => {
  it('does not bind a project snapshot to a removed worktree', async () => {
    const pool: PgPoolLike = {
      connect: async () => {
        throw new Error('not used');
      },
      query: async <Row extends Record<string, unknown>>(
        sql: string,
      ): Promise<PgQueryResult<Row>> => {
        if (sql.includes('w.registered')) return { rows: [] };
        return {
          rows: [
            {
              project_id: 'project-1',
              db_revision: 4,
              worktree_id: 'removed-worktree',
              snapshot_id: 'stale-snapshot',
              head_commit: 'old-head',
              snapshot_head: 'old-head',
              state: 'active',
            },
          ] as unknown as Row[],
        };
      },
    };

    await expect(
      new PgKnowledgeStore(pool).getProjectSnapshot({
        projectKey: 'MC-Platform',
        worktreePath: 'C:/repo/.worktrees/removed',
        maxTokens: 800,
      }),
    ).rejects.toMatchObject({ code: 'INDEX_STALE' });
  });

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
    expect(
      client.statements.find((sql) =>
        sql.includes('SELECT project_id, db_revision'),
      ),
    ).toContain('FOR NO KEY UPDATE');
    expect(client.statements.at(-1)).toBe('ROLLBACK');
    expect(client.released).toBe(true);
  });

  it('validates knowledge change items before opening a DB transaction', async () => {
    const pool: PgPoolLike = {
      connect: async () => {
        throw new Error('should not connect');
      },
      query: async () => ({ rows: [] }),
    };
    await expect(
      new PgKnowledgeStore(pool).writeProjectKnowledge({
        projectKey: 'MC-Platform',
        actor: 'codex',
        changes: [{ operation: 'create', item: null as unknown as never }],
      }),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      retryable: false,
    } satisfies Partial<KnowledgeError>);
  });

  it('rejects an unknown knowledge kind before opening a transaction', async () => {
    const pool: PgPoolLike = {
      connect: async () => {
        throw new Error('should not connect');
      },
      query: async () => ({ rows: [] }),
    };

    await expect(
      new PgKnowledgeStore(pool).writeProjectKnowledge({
        projectKey: 'MC-Platform',
        actor: 'codex',
        changes: [
          {
            operation: 'create',
            item: { kind: 'surprise', title: 'Unknown kind' },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'UNKNOWN_KIND',
      retryable: false,
      details: {
        allowedKinds: expect.arrayContaining(['decision', 'work_item']),
      },
    } satisfies Partial<KnowledgeError>);
  });

  it('normalizes knowledge kind case and surrounding whitespace on write', async () => {
    const client = new KnowledgeWriteClient();
    const store = new PgKnowledgeStore({
      connect: async () => client,
      query: (sql, values) => client.query(sql, values),
    });

    await store.writeProjectKnowledge({
      projectKey: 'MC-Platform',
      actor: 'codex',
      changes: [
        {
          operation: 'create',
          item: { kind: '  DeCiSiOn  ', title: 'Normalized kind' },
        },
      ],
    });

    const insert = client.queries.find(({ sql }) =>
      sql.includes('INSERT INTO project_knowledge.knowledge_items'),
    );
    expect(insert?.values?.[2]).toBe('decision');
  });

  it('stores an embedding hash and priority 100 for knowledge chunks', async () => {
    const client = new KnowledgeWriteClient();
    const store = new PgKnowledgeStore({
      connect: async () => client,
      query: (sql, values) => client.query(sql, values),
    });

    await store.writeProjectKnowledge({
      projectKey: 'MC-Platform',
      actor: 'codex',
      changes: [
        {
          operation: 'create',
          item: {
            kind: 'decision',
            title: 'Embed meaningful chunks',
            bodyMarkdown: 'Knowledge items receive the highest priority.',
          },
        },
      ],
    });

    const chunkInsert = client.queries.find(({ sql }) =>
      sql.includes('INSERT INTO project_knowledge.search_chunks'),
    );
    const embedJob = client.queries.find(({ sql }) =>
      sql.includes("VALUES($1,'embed_chunk'"),
    );
    expect(chunkInsert?.sql).toContain('embed_hash');
    expect(chunkInsert?.values?.[10]).toBe(
      embeddingHash(
        'Embed meaningful chunks\n\nKnowledge items receive the highest priority.',
      ),
    );
    expect(embedJob?.sql).toContain('priority');
    expect(embedJob?.sql).toContain("'embed_chunk',$2,'embedding',100,$3");
    expect(embedJob?.sql).toContain("'publish_item',$4,'publish',0,$5");
  });

  it('preserves compatible vectors when a patch changes only metadata', async () => {
    const client = new KnowledgeWriteClient(existingWorkItem({}));
    const execute = client.query.bind(client);
    client.query = async <Row extends Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ): Promise<PgQueryResult<Row>> => {
      const result = await execute<Row>(sql, values);
      if (sql.includes('SELECT c.embedding,c.embedding_model_id')) {
        expect(values?.slice(2)).toEqual([
          embeddingHash('Claimable work\n\nCoordinate this work.'),
          'model-v1',
          'r1',
          3,
        ]);
        return {
          rows: [
            { embedding: '[1,0,0]', embedding_model_id: 'model-1' },
          ] as unknown as Row[],
        };
      }
      return result;
    };
    const store = new PgKnowledgeStore(
      {
        connect: async () => client,
        query: (sql, values) => client.query(sql, values),
      },
      {
        embeddingCacheModel: {
          name: 'model-v1',
          revision: 'r1',
          dimensions: 3,
        },
      },
    );
    const result = await store.writeProjectKnowledge({
      projectKey: 'MC-Platform',
      actor: 'codex',
      changes: [
        {
          operation: 'patch',
          item: { id: 'item-1', deliveryStatus: 'blocked' },
        },
      ],
    });
    expect(result.changes[0]?.embeddingState).toBe('unchanged');
    expect(result.changes[0]?.version).toBe(2);
    expect(
      client.queries.some(({ sql }) => sql.includes("VALUES($1,'embed_chunk'")),
    ).toBe(false);
    expect(
      client.queries.some(({ sql }) => sql.includes("'publish_item'")),
    ).toBe(true);
    const inserted = client.queries.find(({ sql }) =>
      sql.includes('INSERT INTO project_knowledge.search_chunks'),
    );
    expect(inserted?.values?.slice(12)).toEqual(['[1,0,0]', 'model-1']);
  });

  it('persists a normalized kind when patching an existing item', async () => {
    const client = new KnowledgeWriteClient({
      id: 'item-1',
      stable_key: 'decision:legacy',
      kind: '  DeCiSiOn  ',
      title: 'Legacy decision',
      current_version: 1,
      delivery_status: 'active',
      verification_status: 'unverified',
      domain: null,
      service: null,
      body_markdown: 'Legacy body.',
      properties: {},
      canonical_hash: 'legacy-hash',
    });
    const store = new PgKnowledgeStore({
      connect: async () => client,
      query: (sql, values) => client.query(sql, values),
    });

    await store.writeProjectKnowledge({
      projectKey: 'MC-Platform',
      actor: 'codex',
      changes: [
        {
          operation: 'patch',
          item: { id: 'item-1', bodyMarkdown: 'Normalized body.' },
        },
      ],
    });

    const update = client.queries.find(({ sql }) =>
      sql.includes('UPDATE project_knowledge.knowledge_items SET kind='),
    );
    expect(update?.values?.[2]).toBe('decision');
  });

  it('keeps patching legacy items whose stored kind predates the vocabulary', async () => {
    const client = new KnowledgeWriteClient({
      id: 'item-2',
      stable_key: 'note:legacy',
      kind: 'Implementation-Note',
      title: 'Legacy note',
      current_version: 1,
      delivery_status: null,
      verification_status: 'unverified',
      domain: null,
      service: null,
      body_markdown: 'Legacy body.',
      properties: {},
      canonical_hash: 'legacy-hash',
    });
    const store = new PgKnowledgeStore({
      connect: async () => client,
      query: (sql, values) => client.query(sql, values),
    });

    await store.writeProjectKnowledge({
      projectKey: 'MC-Platform',
      actor: 'claude',
      changes: [
        {
          operation: 'patch',
          item: { id: 'item-2', bodyMarkdown: 'Updated body.' },
        },
      ],
    });

    const update = client.queries.find(({ sql }) =>
      sql.includes('UPDATE project_knowledge.knowledge_items SET kind='),
    );
    expect(update?.values?.[2]).toBe('implementation_note');
  });

  it('accepts a lowercase other slug as a knowledge kind', async () => {
    const client = new KnowledgeWriteClient();
    const store = new PgKnowledgeStore({
      connect: async () => client,
      query: (sql, values) => client.query(sql, values),
    });

    await store.writeProjectKnowledge({
      projectKey: 'MC-Platform',
      actor: 'codex',
      changes: [
        {
          operation: 'create',
          item: { kind: '  OTHER:release-note  ', title: 'Release note' },
        },
      ],
    });

    const insert = client.queries.find(({ sql }) =>
      sql.includes('INSERT INTO project_knowledge.knowledge_items'),
    );
    expect(insert?.values?.[2]).toBe('other:release-note');
  });

  it('rejects a work item claim held by another agent', async () => {
    const claimExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const client = new KnowledgeWriteClient(
      existingWorkItem({ claimedBy: 'claude', claimExpiresAt }),
    );
    const store = new PgKnowledgeStore({
      connect: async () => client,
      query: (sql, values) => client.query(sql, values),
    });

    await expect(
      store.writeProjectKnowledge({
        projectKey: 'MC-Platform',
        actor: 'codex',
        changes: [
          {
            operation: 'patch',
            item: {
              id: 'item-1',
              properties: {
                claimedBy: 'codex',
                claimExpiresAt: new Date(
                  Date.now() + 2 * 60 * 60_000,
                ).toISOString(),
              },
            },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'CLAIM_CONFLICT',
      retryable: false,
      details: { claimedBy: 'claude', claimExpiresAt },
    } satisfies Partial<KnowledgeError>);
    expect(client.statements.at(-1)).toBe('ROLLBACK');
  });

  it('allows the same agent to renew a work item claim', async () => {
    const client = new KnowledgeWriteClient(
      existingWorkItem({
        claimedBy: 'codex',
        claimExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      }),
    );
    const store = new PgKnowledgeStore({
      connect: async () => client,
      query: (sql, values) => client.query(sql, values),
    });
    const renewedUntil = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

    await expect(
      store.writeProjectKnowledge({
        projectKey: 'MC-Platform',
        actor: 'codex',
        changes: [
          {
            operation: 'patch',
            item: {
              id: 'item-1',
              properties: {
                claimedBy: 'codex',
                claimExpiresAt: renewedUntil,
              },
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ summary: { updated: 1 } });
    const version = client.queries.find(({ sql }) =>
      sql.includes('INSERT INTO project_knowledge.knowledge_versions'),
    );
    expect(version?.values?.[4]).toMatchObject({
      claimedBy: 'codex',
      claimExpiresAt: renewedUntil,
    });
  });

  it('allows an expired work item claim to be taken by another agent', async () => {
    const client = new KnowledgeWriteClient(
      existingWorkItem({
        claimedBy: 'claude',
        claimExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const store = new PgKnowledgeStore({
      connect: async () => client,
      query: (sql, values) => client.query(sql, values),
    });
    const claimedUntil = new Date(Date.now() + 60 * 60_000).toISOString();

    await expect(
      store.writeProjectKnowledge({
        projectKey: 'MC-Platform',
        actor: 'codex',
        changes: [
          {
            operation: 'patch',
            item: {
              id: 'item-1',
              properties: {
                claimedBy: 'codex',
                claimExpiresAt: claimedUntil,
              },
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ summary: { updated: 1 } });
    const version = client.queries.find(({ sql }) =>
      sql.includes('INSERT INTO project_knowledge.knowledge_versions'),
    );
    expect(version?.values?.[4]).toMatchObject({
      claimedBy: 'codex',
      claimExpiresAt: claimedUntil,
    });
  });

  it('rejects writes with create/update change missing kind', async () => {
    const clientRows = [{ project_id: 'project-1', db_revision: 1 }];
    const client: PgClientLike = {
      query: async <Row extends Record<string, unknown>>(
        sql: string,
      ): Promise<PgQueryResult<Row>> => {
        if (sql.includes('project_knowledge.projects'))
          return { rows: clientRows as unknown as Row[] };
        if (sql.includes('FOR UPDATE OF i'))
          return { rows: [] as unknown as Row[] };
        return { rows: [] as unknown as Row[] };
      },
      release: () => {},
    };
    const pool: PgPoolLike = {
      connect: async () => client,
      query: client.query,
    };
    await expect(
      new PgKnowledgeStore(pool).writeProjectKnowledge({
        projectKey: 'MC-Platform',
        actor: 'codex',
        changes: [
          {
            operation: 'create',
            item: {
              title: 'Missing kind',
              bodyMarkdown: 'No kind field',
            } as never,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      retryable: false,
    } satisfies Partial<KnowledgeError>);
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

  it('prioritizes catch-up kinds and exposes active work item claims', async () => {
    const claimExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const kinds = ['blocker', 'decision', 'work_item', 'gotcha', 'handoff'];
    const pool: PgPoolLike = {
      connect: async () => {
        throw new Error('not used by recall');
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
        return {
          rows: kinds.map((kind, index) => ({
            id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            kind,
            title: kind,
            content: `${kind} content`,
            content_hash: `${kind}-hash`,
            item_id: `item-${index}`,
            item_version: 1,
            stable_key: `${kind}:${index}`,
            metadata:
              kind === 'work_item'
                ? {
                    citation: kind,
                    claimedBy: 'codex',
                    claimExpiresAt,
                  }
                : { citation: kind },
            head_commit: null,
            db_revision: 4,
          })) as unknown as Row[],
        };
      },
    };

    const result = await new PgKnowledgeStore(pool).recallProjectKnowledge({
      projectKey: 'MC-Platform',
      intent: 'catch_up',
      maxTokens: 2000,
    });

    expect(result.results.map(({ kind }) => kind)).toEqual([
      'handoff',
      'gotcha',
      'decision',
      'blocker',
      'work_item',
    ]);
    expect(result.results.at(-1)).toMatchObject({
      claimedBy: 'codex',
      claimExpiresAt,
    });
  });

  it('deduplicates identical source chunks and applies filters to exact lookup', async () => {
    const chunks = [
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        kind: 'documentation',
        title: 'Architecture',
        content: 'Repeated source text',
        content_hash: 'same-source-hash',
        item_id: null,
        item_version: null,
        stable_key: null,
        metadata: { path: 'docs/architecture.md' },
        head_commit: null,
        db_revision: 4,
      })),
      {
        id: '00000000-0000-4000-8000-000000000004',
        kind: 'decision',
        title: 'Architecture decision',
        content: 'Keep the durable decision',
        content_hash: 'decision-hash',
        item_id: '10000000-0000-4000-8000-000000000001',
        item_version: 1,
        stable_key: 'decision:architecture',
        metadata: { citation: 'knowledge:decision:v1' },
        head_commit: null,
        db_revision: 4,
      },
    ];
    let exactValues: unknown[] | undefined;
    let exactSql = '';
    const pool: PgPoolLike = {
      connect: async () => {
        throw new Error('not used');
      },
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values?: unknown[],
      ): Promise<PgQueryResult<Row>> => {
        if (sql.includes('FROM project_knowledge.projects'))
          return {
            rows: [
              { project_id: 'project-1', db_revision: 4 },
            ] as unknown as Row[],
          };
        exactSql = sql;
        exactValues = values;
        return { rows: chunks as unknown as Row[] };
      },
    };
    const result = await new PgKnowledgeStore(pool).searchProjectContext({
      projectKey: 'MC-Platform',
      query: 'Architecture',
      mode: 'exact',
      filters: { kinds: ['documentation', 'decision'], domains: ['platform'] },
      limit: 12,
      maxTokens: 2000,
    });
    expect(exactValues?.slice(5, 8)).toEqual([
      ['documentation', 'decision'],
      ['platform'],
      null,
    ]);
    expect(exactSql).toContain('c.worktree_id=$5');
    expect(exactSql).toContain('c.kind=ANY($6)');
    expect(exactSql).toContain('c.domain=ANY($7)');
    expect(exactSql).toContain(
      "($2::uuid IS NOT NULL OR c.snapshot_id IS NULL OR s.state='active')",
    );
    expect(result.results.map((hit) => hit.title)).toEqual([
      'Architecture',
      'Architecture decision',
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

  it('guards unscoped hybrid candidates with active snapshot state', async () => {
    let hybridSql = '';
    const pool: PgPoolLike = {
      connect: async () => {
        throw new Error('not used by search');
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
        hybridSql = sql;
        return { rows: [] };
      },
    };

    await new PgKnowledgeStore(pool, {
      embedder: { embed: async () => [0.1, 0.2] },
    }).searchProjectContext({
      projectKey: 'MC-Platform',
      query: 'embedding policy',
      mode: 'hybrid',
      limit: 6,
      maxTokens: 2000,
    });

    expect(hybridSql).toContain(
      'LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id',
    );
    expect(hybridSql).toContain(
      "($2::uuid IS NOT NULL OR c.snapshot_id IS NULL OR s.state='active')",
    );
  });

  it.each([true, false])(
    'scopes documentation freshness to the requested worktree (semantic=%s)',
    async (semantic) => {
      let searchSql = '';
      let searchValues: unknown[] | undefined;
      const base = searchPool(1);
      const pool: PgPoolLike = {
        connect: base.connect,
        query: async <Row extends Record<string, unknown>>(
          sql: string,
          values?: unknown[],
        ): Promise<PgQueryResult<Row>> => {
          if (!sql.includes('FROM project_knowledge.projects')) {
            searchSql = sql;
            searchValues = values;
          }
          return base.query<Row>(sql, values);
        },
      };
      await new PgKnowledgeStore(
        pool,
        semantic ? { embedder: { embed: async () => [0.1, 0.2] } } : {},
      ).searchProjectContext({
        projectKey: 'MC-Platform',
        query: 'architecture',
        mode: 'hybrid',
        worktreeId: 'worktree-a',
        limit: 6,
        maxTokens: 2000,
      });
      expect(searchValues?.[9]).toBe('worktree-a');
      expect(searchSql).toMatch(
        /WHERE item_id=c.item_id AND \(\$2::uuid IS NULL OR snapshot_id=\$2\)\s+AND \(\$10::uuid IS NULL OR worktree_id=\$10\)/u,
      );
    },
  );

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

  it('excludes removed worktrees from the current project sync status', async () => {
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
          return /WHERE w\.project_id=\$1 AND w\.registered/u.test(sql)
            ? { rows: [] }
            : {
                rows: [
                  { id: 'removed-worktree', freshness: 'stale' },
                ] as unknown as Row[],
              };
        return { rows: [] };
      },
    };

    const result = await new PgKnowledgeStore(pool).getProjectSyncStatus({
      projectKey: 'MC-Platform',
      changedOnly: true,
    });

    expect(result.sourceFreshness).toBe('current');
    expect(result.snapshots).toEqual([]);
  });

  it('returns a current-worktree domain audit and keeps unmapped changes stale', async () => {
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
              { project_id: 'project-1', db_revision: 9 },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.worktrees'))
          return {
            rows: [
              {
                worktree_id: 'worktree-1',
                path: 'C:/repo',
                branch: 'feature/rcon',
                head_commit: 'head',
                dirty_hash: 'dirty',
                snapshot_id: 'snapshot-1',
                snapshot_head: 'head',
                snapshot_dirty_hash: 'dirty',
                freshness: 'current',
              },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.domain_sync_states'))
          return {
            rows: [
              {
                worktree_id: 'worktree-1',
                worktree_path: 'C:/repo',
                branch: 'feature/rcon',
                current_commit: 'head',
                current_dirty_hash: 'dirty',
                indexed_commit: 'head',
                indexed_dirty_hash: 'dirty',
                snapshot_id: 'snapshot-1',
                domain: 'Server control',
                note_path:
                  'Published/01 - Architecture/Domains/Server control.md',
                state: 'stale',
                last_synced_commit: 'base',
                last_synced_dirty_hash: null,
                database_revision: 9,
                projection_revision: 8,
                reasons: ['Mapped source paths changed'],
                changed_paths: ['services/host-agent/src/rcon.ts'],
                evidence_refs: ['knowledge:item-1:v2'],
                unmapped_paths: ['scratch/unknown.txt'],
              },
            ] as unknown as Row[],
          };
        return { rows: [] };
      },
    };

    const result = await new PgKnowledgeStore(pool).getProjectSyncStatus({
      projectKey: 'MC-Platform',
      worktreeIds: ['worktree-1'],
      changedOnly: false,
    });

    expect(result.sourceFreshness).toBe('stale');
    expect(result.domainSync).toMatchObject({
      worktreeId: 'worktree-1',
      worktreePath: 'C:/repo',
      currentCommit: 'head',
      unmappedChanges: ['scratch/unknown.txt'],
      domains: [
        {
          name: 'Server control',
          state: 'stale',
          lastSyncedCommit: 'base',
          changedPaths: ['services/host-agent/src/rcon.ts'],
        },
      ],
    });
  });

  it('returns current status with compact summary and no repair actions on clean data', async () => {
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
              { project_id: 'project-1', db_revision: 8 },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.worktrees'))
          return {
            rows: [
              {
                worktree_id: 'worktree-1',
                path: 'C:/repo',
                branch: 'main',
                head_commit: 'head',
                dirty_hash: null,
                dirty_paths: [],
                registered: true,
                snapshot_id: 'snapshot-1',
                snapshot_head: 'head',
                snapshot_dirty_hash: null,
                parser_revision: '1',
                freshness: 'current',
              },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.outbox_jobs'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.note_projections'))
          return {
            rows: [{ state: 'deferred' }] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.projection_conflicts'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.documentation_freshness'))
          return { rows: [{ state: 'current', count: 0 }] as unknown as Row[] };
        if (sql.includes('FROM project_knowledge.agent_tasks'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.domain_sync_states'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.domain_path_rules'))
          return {
            rows: [
              { rule_count: 0, rule_fingerprint: null },
            ] as unknown as Row[],
          };
        if (sql.includes('source_evidence'))
          return {
            rows: [{ evidence_count: 0, mapping_count: 0 }] as unknown as Row[],
          };
        return { rows: [] };
      },
    };

    const result = await new PgKnowledgeStore(pool).getProjectSyncStatus({
      projectKey: 'MC-Platform',
      changedOnly: true,
    });

    expect(result.sourceFreshness).toBe('current');
    expect(result.summary).toMatchObject({
      dirtyWorktrees: 0,
      staleSources: 0,
      staleEvidence: 0,
      staleProjections: 0,
      deferredProjections: 1,
      pendingJobs: 0,
      failedJobs: 0,
    });
    expect(result.topIssues).toEqual([]);
    expect(result.topSuggestedActions).toEqual([]);
  });

  it('returns a stable hash-aware recall and suppresses unchanged results', async () => {
    const store = new PgKnowledgeStore(searchPool(2));
    const first = await store.recallProjectKnowledge({
      projectKey: 'MC-Platform',
      intent: 'find',
      query: 'authentication architecture',
      maxTokens: 600,
    });

    expect(first.status).toBe('modified');
    expect(first.results).toHaveLength(2);
    expect(first.stateHash).toMatch(/^[a-f0-9]{64}$/u);

    const second = await store.recallProjectKnowledge({
      projectKey: 'MC-Platform',
      intent: 'find',
      query: 'authentication architecture',
      knownStateHash: first.stateHash,
      maxTokens: 600,
    });
    expect(second).toMatchObject({
      status: 'not_modified',
      stateHash: first.stateHash,
      results: [],
    });
  });

  it.each(['head', 'dirty'])(
    'invalidates bound recall freshness when the worktree %s changes',
    async (changed) => {
      let head = 'indexed-head';
      let dirty = 'indexed-dirty';
      const base = searchPool(1);
      const pool: PgPoolLike = {
        connect: base.connect,
        query: async <Row extends Record<string, unknown>>(
          sql: string,
          values?: unknown[],
        ): Promise<PgQueryResult<Row>> => {
          if (sql.includes('project_knowledge.retrieval_epochs'))
            return {
              rows: [
                { db_revision: 4, retrieval_epoch: '1' },
              ] as unknown as Row[],
            };
          if (sql.includes('JOIN project_knowledge.repositories'))
            return {
              rows: [
                {
                  project_id: 'project-1',
                  db_revision: 4,
                  worktree_id: 'worktree-1',
                  snapshot_id: 'snapshot-1',
                  head_commit: head,
                  snapshot_head: 'indexed-head',
                  dirty_hash: dirty,
                  snapshot_dirty_hash: 'indexed-dirty',
                  state: 'active',
                },
              ] as unknown as Row[],
            };
          return base.query<Row>(sql, values);
        },
      };
      const store = new PgKnowledgeStore(pool);
      const input = {
        projectKey: 'MC-Platform',
        intent: 'find' as const,
        query: 'architecture',
        worktreePath: 'C:/repo',
        maxTokens: 600,
      };
      const first = await store.recallProjectKnowledge(input);
      expect(first.freshness).toBe('current');
      if (changed === 'head') head = 'next-head';
      else dirty = 'changed-dirty';
      const second = await store.recallProjectKnowledge({
        ...input,
        knownStateHash: first.stateHash,
      });
      expect(second.freshness).toBe('stale');
      expect(second.status).toBe('modified');
      expect(second.stateHash).not.toBe(first.stateHash);
    },
  );

  it('reuses unchanged recall retrieval but invalidates on epochs, scope, budget and claim expiry', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-31T00:00:00Z'));
      let epoch = '1';
      let retrievals = 0;
      const base = searchPool(1);
      const pool: PgPoolLike = {
        connect: base.connect,
        query: async <Row extends Record<string, unknown>>(
          sql: string,
          values?: unknown[],
        ): Promise<PgQueryResult<Row>> => {
          if (sql.includes('project_knowledge.retrieval_epochs'))
            return {
              rows: [
                { db_revision: 4, retrieval_epoch: epoch },
              ] as unknown as Row[],
            };
          const result = await base.query<Row>(sql, values);
          if (!sql.includes('FROM project_knowledge.projects')) {
            retrievals++;
            result.rows = result.rows.map((row) => ({
              ...row,
              metadata: {
                claimedBy: 'codex',
                claimExpiresAt: '2026-10-31T00:00:05Z',
              },
            }));
          }
          return result;
        },
      };
      const store = new PgKnowledgeStore(pool);
      const input = {
        projectKey: 'MC-Platform',
        intent: 'find' as const,
        query: 'architecture',
        maxTokens: 600,
      };
      const first = await store.recallProjectKnowledge(input);
      const repeated = await store.recallProjectKnowledge({
        ...input,
        knownStateHash: first.stateHash,
      });
      expect(repeated.status).toBe('not_modified');
      expect(retrievals).toBe(1);
      epoch = '2';
      await store.recallProjectKnowledge(input);
      expect(retrievals).toBe(2);
      await store.recallProjectKnowledge({
        ...input,
        worktreeId: 'worktree-b',
      });
      await store.recallProjectKnowledge({ ...input, maxTokens: 700 });
      expect(retrievals).toBe(4);
      vi.advanceTimersByTime(5001);
      const expired = await store.recallProjectKnowledge(input);
      expect(expired.results[0]?.claimedBy).toBeUndefined();
      expect(retrievals).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache recall when a mutation commits during retrieval', async () => {
    let epoch = 0;
    let retrievals = 0;
    const base = searchPool(1);
    const pool: PgPoolLike = {
      connect: base.connect,
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values?: unknown[],
      ): Promise<PgQueryResult<Row>> => {
        if (sql.includes('project_knowledge.retrieval_epochs'))
          return {
            rows: [
              { db_revision: 4, retrieval_epoch: String(epoch) },
            ] as unknown as Row[],
          };
        if (!sql.includes('FROM project_knowledge.projects')) {
          epoch++;
          retrievals++;
        }
        return base.query<Row>(sql, values);
      },
    };
    const store = new PgKnowledgeStore(pool);
    const input = {
      projectKey: 'MC-Platform',
      intent: 'find' as const,
      query: 'architecture',
      maxTokens: 600,
    };
    await store.recallProjectKnowledge(input);
    await store.recallProjectKnowledge(input);
    expect(retrievals).toBe(2);
  });

  it('bounds recall cache entries and expires old results', async () => {
    vi.useFakeTimers();
    try {
      let retrievals = 0;
      const base = searchPool(1);
      const pool: PgPoolLike = {
        connect: base.connect,
        query: async <Row extends Record<string, unknown>>(
          sql: string,
          values?: unknown[],
        ): Promise<PgQueryResult<Row>> => {
          if (sql.includes('project_knowledge.retrieval_epochs'))
            return {
              rows: [
                { db_revision: 4, retrieval_epoch: '1' },
              ] as unknown as Row[],
            };
          if (!sql.includes('FROM project_knowledge.projects')) retrievals++;
          return base.query<Row>(sql, values);
        },
      };
      const store = new PgKnowledgeStore(pool);
      const input = {
        projectKey: 'MC-Platform',
        intent: 'find' as const,
        maxTokens: 600,
      };
      for (let index = 0; index < 65; index++)
        await store.recallProjectKnowledge({
          ...input,
          query: `query ${index}`,
        });
      await store.recallProjectKnowledge({ ...input, query: 'query 64' });
      expect(retrievals).toBe(65);
      await store.recallProjectKnowledge({ ...input, query: 'query 0' });
      expect(retrievals).toBe(66);
      vi.advanceTimersByTime(30_001);
      await store.recallProjectKnowledge({ ...input, query: 'query 64' });
      expect(retrievals).toBe(67);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries degraded semantic recall and separates filter scopes', async () => {
    let available = false;
    let computations = 0;
    const base = searchPool(1);
    const pool: PgPoolLike = {
      connect: base.connect,
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values?: unknown[],
      ): Promise<PgQueryResult<Row>> => {
        if (sql.includes('project_knowledge.retrieval_epochs'))
          return {
            rows: [
              { db_revision: 4, retrieval_epoch: '1' },
            ] as unknown as Row[],
          };
        return base.query<Row>(sql, values);
      },
    };
    const store = new PgKnowledgeStore(pool, {
      embedder: {
        embed: async () => {
          computations++;
          if (!available) throw new Error('model unavailable');
          return [0.1, 0.2];
        },
      },
    });
    const input = {
      projectKey: 'MC-Platform',
      intent: 'find' as const,
      query: 'architecture',
      maxTokens: 600,
    };
    expect((await store.recallProjectKnowledge(input)).warnings).toHaveLength(
      1,
    );
    available = true;
    expect(
      (await store.recallProjectKnowledge(input)).warnings ?? [],
    ).toHaveLength(0);
    await store.recallProjectKnowledge(input);
    expect(computations).toBe(2);
    await store.recallProjectKnowledge({
      ...input,
      filters: { kinds: ['decision'] },
    });
    expect(computations).toBe(3);
  });

  it('returns changed freshness even when content and database revision are unchanged', async () => {
    let freshness = 'current';
    const base = searchPool(1);
    const pool: PgPoolLike = {
      connect: base.connect,
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values?: unknown[],
      ): Promise<PgQueryResult<Row>> => {
        const result = await base.query<Row>(sql, values);
        if (!sql.includes('FROM project_knowledge.projects')) {
          result.rows = result.rows.map((row) => ({
            ...row,
            documentation_freshness: freshness,
          }));
        }
        return result;
      },
    };
    const store = new PgKnowledgeStore(pool);
    const input = {
      projectKey: 'MC-Platform',
      intent: 'find' as const,
      query: 'architecture',
      maxTokens: 600,
    };
    const first = await store.recallProjectKnowledge(input);
    expect(first.results[0]?.documentationFreshness).toBe('current');
    freshness = 'stale';
    const second = await store.recallProjectKnowledge({
      ...input,
      knownStateHash: first.stateHash,
    });
    expect(second.status).toBe('modified');
    expect(second.results[0]?.documentationFreshness).toBe('stale');
    expect(second.stateHash).not.toBe(first.stateHash);
  });

  it('omits records whose item hash is already known by the caller', async () => {
    const store = new PgKnowledgeStore(searchPool(2));
    const result = await store.recallProjectKnowledge({
      projectKey: 'MC-Platform',
      intent: 'orient',
      knownItemHashes: {
        '10000000-0000-4000-8000-000000000001': 'hash-1',
      },
      maxTokens: 600,
    });

    expect(result.results.map((hit) => hit.contentHash)).toEqual(['hash-2']);
    expect(result.unchangedResults).toBe(1);
  });

  it('aggregates UUID evidence and mapping versions using PostgreSQL-supported expressions', async () => {
    const base = syncStatusPool({ projectKey: 'project-uuid-versions' });
    const pool: PgPoolLike = {
      connect: base.connect,
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ): Promise<PgQueryResult<Row>> => {
        if (/MAX\(id\)::text/u.test(sql)) {
          throw Object.assign(new Error('function max(uuid) does not exist'), {
            code: '42883',
          });
        }
        return base.query<Row>(sql, params);
      },
    };

    await expect(
      new PgKnowledgeStore(pool).getProjectSyncStatus({
        projectKey: 'project-uuid-versions',
        changedOnly: true,
      }),
    ).resolves.toMatchObject({
      sourceFreshness: 'current',
    });
  });

  it('suggests reindex and update actions for a mapped changed path', async () => {
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
              { project_id: 'project-1', db_revision: 12 },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.worktrees'))
          return {
            rows: [
              {
                worktree_id: 'worktree-1',
                path: 'C:/repo',
                branch: 'main',
                head_commit: 'head',
                dirty_hash: 'dirty',
                dirty_paths: ['services/api/src/users.ts'],
                registered: true,
                snapshot_id: 'snapshot-1',
                snapshot_head: 'head',
                snapshot_dirty_hash: 'clean',
                parser_revision: '1',
                freshness: 'stale',
              },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.outbox_jobs'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.note_projections'))
          return {
            rows: [{ state: 'current' }] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.projection_conflicts'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.documentation_freshness'))
          return { rows: [{ state: 'current', count: 0 }] as unknown as Row[] };
        if (sql.includes('FROM project_knowledge.agent_tasks'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.domain_sync_states'))
          return {
            rows: [
              {
                worktree_id: 'worktree-1',
                worktree_path: 'C:/repo',
                branch: 'main',
                current_commit: 'head',
                current_dirty_hash: 'dirty',
                indexed_commit: 'head',
                indexed_dirty_hash: 'clean',
                snapshot_id: 'snapshot-1',
                domain: 'Auth',
                note_path: 'Published/Auth.md',
                state: 'stale',
                last_synced_commit: 'base',
                last_synced_dirty_hash: null,
                database_revision: 12,
                projection_revision: 11,
                reasons: ['Mapped source changed'],
                changed_paths: ['services/auth/src/token.ts'],
                evidence_refs: ['knowledge:item-9:v3'],
                unmapped_paths: [],
              },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.domain_path_rules'))
          return {
            rows: [
              { rule_count: 4, rule_fingerprint: '2026-09-09' },
            ] as unknown as Row[],
          };
        if (sql.includes('source_evidence'))
          return {
            rows: [
              {
                evidence_count: 12,
                mapping_count: 3,
              },
            ] as unknown as Row[],
          };
        if (sql.includes('source_path=ANY'))
          return {
            rows: [
              {
                source_path: 'services/auth/src/token.ts',
                item_id: 'item-auth-token',
                stable_key: 'api_contract:auth-token',
                title: 'Auth token contract',
              },
            ] as unknown as Row[],
          };
        return { rows: [] };
      },
    };

    const result = await new PgKnowledgeStore(pool).getProjectSyncStatus({
      projectKey: 'MC-Platform',
      changedOnly: true,
      issueLimit: 10,
      actionLimit: 10,
    });

    const actions = result.topSuggestedActions ?? [];
    expect(actions.map((action) => action.action)).toContain('REINDEX_SOURCE');
    expect(actions.map((action) => action.action)).toContain(
      'UPDATE_KNOWLEDGE',
    );
    expect(actions.some((action) => action.action === 'UPDATE_KNOWLEDGE')).toBe(
      true,
    );
    expect(
      actions.some(
        (action) =>
          action.action === 'UPDATE_KNOWLEDGE' && action.dependsOn?.length,
      ),
    ).toBe(true);
    expect(actions[0]?.domain).toBe('Auth');
  });

  it('keeps unmappedChanges visible with changedOnly true and current domains', async () => {
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
              { project_id: 'project-1', db_revision: 8 },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.worktrees'))
          return {
            rows: [
              {
                worktree_id: 'worktree-1',
                path: 'C:/repo',
                branch: 'main',
                head_commit: 'head',
                dirty_hash: 'dirty',
                dirty_paths: ['scratch/unknown.txt'],
                registered: true,
                snapshot_id: 'snapshot-1',
                snapshot_head: 'head',
                snapshot_dirty_hash: 'dirty',
                parser_revision: '1',
                freshness: 'current',
              },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.outbox_jobs'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.note_projections'))
          return {
            rows: [
              { state: 'current', relative_path: 'Published/Sync.md' },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.projection_conflicts'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.documentation_freshness'))
          return { rows: [{ state: 'current', count: 0 }] as unknown as Row[] };
        if (sql.includes('FROM project_knowledge.agent_tasks'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.domain_sync_states'))
          return {
            rows: [
              {
                worktree_id: 'worktree-1',
                worktree_path: 'C:/repo',
                branch: 'main',
                current_commit: 'head',
                current_dirty_hash: 'dirty',
                indexed_commit: 'head',
                indexed_dirty_hash: 'dirty',
                snapshot_id: 'snapshot-1',
                domain: 'Server control',
                note_path: 'Published/Auth.md',
                state: 'current',
                last_synced_commit: 'head',
                last_synced_dirty_hash: 'dirty',
                database_revision: 8,
                projection_revision: 8,
                reasons: [],
                changed_paths: [],
                evidence_refs: [],
                unmapped_paths: ['scratch/unknown.txt'],
              },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.domain_path_rules'))
          return {
            rows: [
              { rule_count: 4, rule_fingerprint: '2026-09-09' },
            ] as unknown as Row[],
          };
        if (sql.includes('source_evidence'))
          return {
            rows: [
              { evidence_count: 11, mapping_count: 3 },
            ] as unknown as Row[],
          };
        if (sql.includes('source_path=ANY')) return { rows: [] };
        return { rows: [] };
      },
    };

    const result = await new PgKnowledgeStore(pool).getProjectSyncStatus({
      projectKey: 'MC-Platform',
      changedOnly: true,
    });

    expect(result.sourceFreshness).toBe('stale');
    expect(result.domainSync?.unmappedChanges).toEqual(['scratch/unknown.txt']);
    expect(result.domainSync?.domains).toHaveLength(0);
  });

  it('reports finalize projection as action when only projection revision is behind', async () => {
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
              { project_id: 'project-1', db_revision: 18 },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.worktrees'))
          return {
            rows: [
              {
                worktree_id: 'worktree-1',
                path: 'C:/repo',
                branch: 'main',
                head_commit: 'head',
                dirty_hash: null,
                dirty_paths: [],
                registered: true,
                snapshot_id: 'snapshot-1',
                snapshot_head: 'head',
                snapshot_dirty_hash: null,
                parser_revision: '1',
                freshness: 'current',
              },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.outbox_jobs'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.note_projections'))
          return {
            rows: [
              { state: 'stale', relative_path: 'Published/Auth.md' },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.projection_conflicts'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.documentation_freshness'))
          return { rows: [{ state: 'current', count: 0 }] as unknown as Row[] };
        if (sql.includes('FROM project_knowledge.agent_tasks'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.domain_sync_states'))
          return {
            rows: [
              {
                worktree_id: 'worktree-1',
                worktree_path: 'C:/repo',
                branch: 'main',
                current_commit: 'head',
                current_dirty_hash: null,
                indexed_commit: 'head',
                indexed_dirty_hash: null,
                snapshot_id: 'snapshot-1',
                domain: 'Auth',
                note_path: 'Published/Auth.md',
                state: 'stale',
                last_synced_commit: 'head',
                last_synced_dirty_hash: null,
                database_revision: 18,
                projection_revision: 16,
                reasons: ['projection pending publish'],
                changed_paths: [],
                evidence_refs: [],
                unmapped_paths: [],
              },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.domain_path_rules'))
          return {
            rows: [
              { rule_count: 4, rule_fingerprint: '2026-09-09' },
            ] as unknown as Row[],
          };
        if (sql.includes('source_evidence'))
          return {
            rows: [{ evidence_count: 7, mapping_count: 3 }] as unknown as Row[],
          };
        if (sql.includes('source_path=ANY')) return { rows: [] };
        return { rows: [] };
      },
    };

    const result = await new PgKnowledgeStore(pool).getProjectSyncStatus({
      projectKey: 'MC-Platform',
      changedOnly: false,
      actionLimit: 10,
    });

    expect(result.topSuggestedActions?.map((action) => action.action)).toEqual([
      'FINALIZE_PROJECTION',
    ]);
    expect(result.topSuggestedActions?.[0]?.changedPaths).toEqual([]);
  });

  it('plans source reindexing from a stale snapshot before domain audit rows exist', async () => {
    const result = await new PgKnowledgeStore(
      syncStatusPool({
        projectKey: 'snapshot-fallback',
        snapshots: [
          {
            worktree_id: 'worktree-fallback',
            path: 'C:/fallback',
            branch: 'main',
            head_commit: 'head',
            dirty_hash: 'dirty',
            dirty_paths: ['src/new.ts'],
            snapshot_id: 'snapshot-old',
            parser_revision: '1',
            freshness: 'stale',
          },
        ],
      }),
    ).getProjectSyncStatus({
      projectKey: 'snapshot-fallback',
      changedOnly: true,
    });

    expect(result.topSuggestedActions?.map((entry) => entry.action)).toEqual([
      'REINDEX_SOURCE',
    ]);
    expect(result.topSuggestedActions?.[0]?.changedPaths).toEqual([
      'src/new.ts',
    ]);
  });

  it('plans worker finalization for pending jobs without domain audit rows', async () => {
    const result = await new PgKnowledgeStore(
      syncStatusPool({
        projectKey: 'pending-fallback',
        snapshots: [
          {
            worktree_id: 'worktree-pending',
            path: 'C:/pending',
            branch: 'main',
            head_commit: 'head',
            dirty_hash: null,
            dirty_paths: [],
            snapshot_id: 'snapshot-pending',
            parser_revision: '1',
            freshness: 'current',
          },
        ],
        queues: [{ state: 'pending', count: 3 }],
      }),
    ).getProjectSyncStatus({
      projectKey: 'pending-fallback',
      changedOnly: true,
    });

    expect(result.topSuggestedActions?.map((entry) => entry.action)).toEqual([
      'FINALIZE_PROJECTION',
    ]);
  });

  it('ranks failed jobs above stale source issues and keeps mixed blockers actionable', async () => {
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
              { project_id: 'project-1', db_revision: 8 },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.worktrees'))
          return {
            rows: [
              {
                worktree_id: 'worktree-1',
                path: 'C:/repo',
                branch: 'main',
                head_commit: 'head',
                dirty_hash: 'dirty',
                dirty_paths: ['services/auth/src/token.ts'],
                registered: true,
                snapshot_id: 'snapshot-1',
                snapshot_head: 'head',
                snapshot_dirty_hash: 'clean',
                parser_revision: '1',
                freshness: 'stale',
              },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.outbox_jobs'))
          return {
            rows: [
              { state: 'pending', count: 1 },
              { state: 'failed', count: 2 },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.note_projections'))
          return { rows: [{ state: 'stale' }] as unknown as Row[] };
        if (sql.includes('FROM project_knowledge.projection_conflicts'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.documentation_freshness'))
          return { rows: [{ state: 'stale', count: 3 }] as unknown as Row[] };
        if (sql.includes('FROM project_knowledge.agent_tasks'))
          return { rows: [] };
        if (sql.includes('FROM project_knowledge.domain_sync_states'))
          return {
            rows: [
              {
                worktree_id: 'worktree-1',
                worktree_path: 'C:/repo',
                branch: 'main',
                current_commit: 'head',
                current_dirty_hash: 'dirty',
                indexed_commit: 'head',
                indexed_dirty_hash: 'clean',
                snapshot_id: 'snapshot-1',
                domain: 'Auth',
                note_path: 'Published/Auth.md',
                state: 'stale',
                last_synced_commit: 'base',
                last_synced_dirty_hash: null,
                database_revision: 8,
                projection_revision: 6,
                reasons: ['changed source'],
                changed_paths: ['services/auth/src/token.ts'],
                evidence_refs: ['knowledge:item-1:v2'],
                unmapped_paths: [],
              },
            ] as unknown as Row[],
          };
        if (sql.includes('FROM project_knowledge.domain_path_rules'))
          return {
            rows: [
              { rule_count: 1, rule_fingerprint: '2026-09-09' },
            ] as unknown as Row[],
          };
        if (sql.includes('source_evidence'))
          return {
            rows: [
              { evidence_count: 17, mapping_count: 12 },
            ] as unknown as Row[],
          };
        if (sql.includes('source_path=ANY'))
          return {
            rows: [
              {
                source_path: 'services/auth/src/token.ts',
                item_id: 'item-auth-token',
                stable_key: 'api_contract:auth-token',
                title: 'Auth token contract',
              },
            ] as unknown as Row[],
          };
        return { rows: [] };
      },
    };

    const result = await new PgKnowledgeStore(pool).getProjectSyncStatus({
      projectKey: 'MC-Platform',
      changedOnly: true,
      issueLimit: 10,
      actionLimit: 10,
    });

    expect(result.summary?.failedJobs).toBe(2);
    expect(result.sourceFreshness).toBe('stale');
    expect(result.topIssues?.[0]).toContain('failed sync');
    expect(result.topSuggestedActions?.map((action) => action.action)).toEqual(
      expect.arrayContaining(['REINDEX_SOURCE', 'UPDATE_KNOWLEDGE']),
    );
  });

  it('treats queued work as a blocker even when sources and projections are current', async () => {
    const result = await new PgKnowledgeStore(
      syncStatusPool({
        projectKey: 'jobs-only',
        snapshots: [
          {
            worktree_id: 'worktree-jobs',
            path: 'C:/jobs',
            branch: 'main',
            head_commit: 'head',
            dirty_hash: null,
            dirty_paths: [],
            snapshot_id: 'snapshot-jobs',
            parser_revision: '1',
            freshness: 'current',
          },
        ],
        projections: [{ state: 'current' }],
        queues: [{ state: 'pending', count: 2 }],
        freshness: [{ state: 'current', count: 1 }],
      }),
    ).getProjectSyncStatus({
      projectKey: 'jobs-only',
      changedOnly: true,
    });

    expect(result.sourceFreshness).toBe('stale');
    expect(result.topIssues?.[0]).toContain('pending sync');
  });

  it('orders repair dependencies first and returns bounded exact evidence hints', async () => {
    const changedPaths = Array.from(
      { length: 20 },
      (_, index) => `services/auth/src/file-${index}.ts`,
    );
    const evidenceRefs = Array.from(
      { length: 14 },
      (_, index) =>
        `chunk:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    const result = await new PgKnowledgeStore(
      syncStatusPool({
        projectKey: 'bounded-actions',
        dbRevision: 9,
        snapshots: [
          {
            worktree_id: 'worktree-bounded',
            path: 'C:/bounded',
            branch: 'feature',
            head_commit: 'head',
            dirty_hash: 'dirty',
            dirty_paths: changedPaths,
            snapshot_id: 'snapshot-bounded',
            parser_revision: '1',
            freshness: 'stale',
          },
        ],
        projections: [{ state: 'current' }],
        freshness: [{ state: 'missing', count: 1 }],
        domains: [
          {
            worktree_id: 'worktree-bounded',
            worktree_path: 'C:/bounded',
            branch: 'feature',
            current_commit: 'head',
            current_dirty_hash: 'dirty',
            indexed_commit: 'base',
            indexed_dirty_hash: null,
            snapshot_id: 'snapshot-bounded',
            domain: 'Auth',
            note_path: 'Published/Auth.md',
            state: 'missing',
            last_synced_commit: null,
            last_synced_dirty_hash: null,
            database_revision: 9,
            projection_revision: 9,
            reasons: ['Required source evidence is missing'],
            changed_paths: changedPaths,
            evidence_refs: evidenceRefs,
            unmapped_paths: [],
          },
        ],
        evidence: changedPaths.map((source_path, index) => ({
          source_path,
          item_id: `item-${index}`,
          stable_key: `item:${index}`,
          title: `Item ${index}`,
        })),
      }),
    ).getProjectSyncStatus({
      projectKey: 'bounded-actions',
      changedOnly: true,
      compact: true,
    });

    const actions = result.topSuggestedActions ?? [];
    expect(actions.map((action) => action.action)).toEqual([
      'REINDEX_SOURCE',
      'VERIFY_EVIDENCE',
    ]);
    expect(actions[1]?.relatedItemIds?.length).toBeGreaterThan(0);
    expect(actions[1]?.evidenceRefs?.length).toBeGreaterThan(0);
    expect(actions[1]?.dependsOn).toEqual([actions[0]?.actionId]);
    expect(actions[0]?.changedPaths.length).toBeLessThan(changedPaths.length);
    expect(actions[1]?.omitted?.changedPaths).toBeGreaterThan(0);
    expect(actions[1]?.omitted?.evidenceRefs).toBeGreaterThan(0);
    expect(result.domainSync?.domains[0]?.changedPaths.length).toBeLessThan(
      changedPaths.length,
    );
    expect(result.domainSync?.domains[0]?.evidenceRefs.length).toBeLessThan(
      evidenceRefs.length,
    );
    expect(result.domainSync?.omitted?.changedPaths).toBeGreaterThan(0);
    expect(result.domainSync?.omitted?.evidenceRefs).toBeGreaterThan(0);
    const compactSnapshot = result.snapshots[0] as {
      dirty_paths: string[];
      omitted_dirty_paths?: number;
    };
    expect(compactSnapshot.dirty_paths.length).toBeLessThan(
      changedPaths.length,
    );
    expect(compactSnapshot.omitted_dirty_paths).toBeGreaterThan(0);
  });

  it('applies changedOnly to full domain details without hiding overall unmapped blockers', async () => {
    const result = await new PgKnowledgeStore(
      syncStatusPool({
        projectKey: 'full-filter',
        snapshots: [
          {
            worktree_id: 'worktree-full',
            path: 'C:/full',
            branch: 'main',
            head_commit: 'head',
            dirty_hash: 'dirty',
            dirty_paths: ['scratch/unmapped.txt'],
            snapshot_id: 'snapshot-full',
            parser_revision: '1',
            freshness: 'current',
          },
        ],
        domains: [
          {
            worktree_id: 'worktree-full',
            worktree_path: 'C:/full',
            branch: 'main',
            current_commit: 'head',
            current_dirty_hash: 'dirty',
            indexed_commit: 'head',
            indexed_dirty_hash: 'dirty',
            snapshot_id: 'snapshot-full',
            domain: 'Current domain',
            note_path: 'Published/Current.md',
            state: 'current',
            database_revision: 1,
            projection_revision: 1,
            reasons: [],
            changed_paths: [],
            evidence_refs: [],
            unmapped_paths: ['scratch/unmapped.txt'],
          },
          {
            worktree_id: 'worktree-full',
            worktree_path: 'C:/full',
            branch: 'main',
            current_commit: 'head',
            current_dirty_hash: 'dirty',
            indexed_commit: 'head',
            indexed_dirty_hash: 'dirty',
            snapshot_id: 'snapshot-full',
            domain: 'Stale domain',
            note_path: 'Published/Stale.md',
            state: 'stale',
            database_revision: 1,
            projection_revision: 1,
            reasons: ['Mapped source paths changed'],
            changed_paths: ['services/stale.ts'],
            evidence_refs: [],
            unmapped_paths: [],
          },
        ],
      }),
    ).getProjectSyncStatus({
      projectKey: 'full-filter',
      changedOnly: true,
      compact: false,
    });

    expect(result.domainSync?.domains.map((domain) => domain.name)).toEqual([
      'Stale domain',
    ]);
    expect(result.domainSync?.unmappedChanges).toEqual([
      'scratch/unmapped.txt',
    ]);
  });

  it('does not reuse a cached action list created with a smaller limit', async () => {
    const store = new PgKnowledgeStore(
      syncStatusPool({
        projectKey: 'cache-limits',
        dbRevision: 5,
        snapshots: [
          {
            worktree_id: 'worktree-cache',
            path: 'C:/cache',
            branch: 'main',
            head_commit: 'head',
            dirty_hash: 'dirty',
            dirty_paths: ['services/cache.ts'],
            snapshot_id: 'snapshot-cache',
            parser_revision: '1',
            freshness: 'stale',
          },
        ],
        domains: [
          {
            worktree_id: 'worktree-cache',
            worktree_path: 'C:/cache',
            branch: 'main',
            current_commit: 'head',
            current_dirty_hash: 'dirty',
            indexed_commit: 'head',
            indexed_dirty_hash: null,
            snapshot_id: 'snapshot-cache',
            domain: 'Cache',
            note_path: 'Published/Cache.md',
            state: 'stale',
            database_revision: 5,
            projection_revision: 4,
            reasons: ['Mapped source paths changed'],
            changed_paths: ['services/cache.ts'],
            evidence_refs: [],
            unmapped_paths: [],
          },
        ],
      }),
    );

    const first = await store.getProjectSyncStatus({
      projectKey: 'cache-limits',
      changedOnly: true,
      actionLimit: 1,
    });
    const second = await store.getProjectSyncStatus({
      projectKey: 'cache-limits',
      changedOnly: true,
      actionLimit: 10,
    });

    expect(first.topSuggestedActions).toHaveLength(1);
    expect(second.topSuggestedActions).toHaveLength(2);
  });

  it('rejects verified completion when the task changed sources linked to stale required documentation', async () => {
    class GateClient extends FakeClient {
      override async query<
        Row extends Record<string, unknown> = Record<string, unknown>,
      >(sql: string): Promise<PgQueryResult<Row>> {
        this.statements.push(sql);
        if (
          sql.includes('FROM project_knowledge.projects') &&
          sql.includes('FOR NO KEY UPDATE')
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
          sql.includes('FOR NO KEY UPDATE')
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

  it('rejects a patch when the expected canonical hash changed', async () => {
    class HashClient extends FakeClient {
      override async query<
        Row extends Record<string, unknown> = Record<string, unknown>,
      >(sql: string): Promise<PgQueryResult<Row>> {
        this.statements.push(sql);
        if (sql.includes('FROM project_knowledge.projects'))
          return {
            rows: [
              { project_id: 'project-1', db_revision: 3 },
            ] as unknown as Row[],
          };
        if (sql.includes('FOR UPDATE OF i'))
          return {
            rows: [
              {
                id: 'item-1',
                stable_key: 'decision:sql',
                kind: 'decision',
                title: 'Use SQL',
                current_version: 2,
                delivery_status: 'active',
                verification_status: 'unverified',
                domain: null,
                service: null,
                body_markdown: 'PostgreSQL is canonical.',
                properties: {},
                canonical_hash: 'current-hash',
              },
            ] as unknown as Row[],
          };
        return { rows: [] };
      }
    }
    const client = new HashClient();
    const store = new PgKnowledgeStore({
      connect: async () => client,
      query: (sql) => client.query(sql),
    });

    await expect(
      store.writeProjectKnowledge({
        projectKey: 'MC-Platform',
        actor: 'codex',
        message: 'Clarify the SQL decision',
        reason: 'correction',
        idempotencyKey: 'write-1',
        changes: [
          {
            operation: 'patch',
            expectedHash: 'stale-hash',
            item: { id: 'item-1', kind: 'decision', bodyMarkdown: 'Updated' },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(client.statements.at(-1)).toBe('ROLLBACK');
  });

  it('replays a committed key even after the caller project revision becomes stale', async () => {
    const receipt = {
      changeSetId: 'committed',
      revisionBefore: 1,
      revisionAfter: 2,
    };
    const statements: string[] = [];
    const client: PgClientLike = {
      release() {},
      async query<Row extends Record<string, unknown>>(
        sql: string,
      ): Promise<PgQueryResult<Row>> {
        statements.push(sql);
        if (sql.includes('FROM project_knowledge.projects'))
          return {
            rows: [
              { project_id: 'project-1', db_revision: 3 },
            ] as unknown as Row[],
          };
        if (sql.includes('SELECT receipt'))
          return { rows: [{ receipt }] as unknown as Row[] };
        return { rows: [] };
      },
    };
    const store = new PgKnowledgeStore({
      connect: async () => client,
      query: client.query,
    });
    await expect(
      store.writeProjectKnowledge({
        projectKey: 'MC-Platform',
        actor: 'codex',
        idempotencyKey: 'committed',
        expectedProjectRevision: 1,
        changes: [{ operation: 'patch', item: { id: 'item-1' } }],
      }),
    ).resolves.toMatchObject({ ...receipt, replayed: true });
    expect(
      statements.some(
        (sql) =>
          sql.includes('INSERT') || sql.includes('UPDATE project_knowledge'),
      ),
    ).toBe(false);
  });

  it('returns no_change without bumping the project revision or queuing jobs', async () => {
    const currentRecord = {
      kind: 'decision',
      title: 'Use SQL',
      bodyMarkdown: 'PostgreSQL is canonical.',
      properties: {},
      deliveryStatus: 'active',
      verificationStatus: 'unverified',
      domain: null,
      service: null,
    };
    const currentHash = canonicalHash(currentRecord);
    class NoChangeClient extends FakeClient {
      override async query<
        Row extends Record<string, unknown> = Record<string, unknown>,
      >(sql: string): Promise<PgQueryResult<Row>> {
        this.statements.push(sql);
        if (sql.includes('FROM project_knowledge.projects'))
          return {
            rows: [
              { project_id: 'project-1', db_revision: 3 },
            ] as unknown as Row[],
          };
        if (sql.includes('FOR UPDATE OF i'))
          return {
            rows: [
              {
                id: 'item-1',
                stable_key: 'decision:sql',
                kind: 'decision',
                title: 'Use SQL',
                current_version: 2,
                delivery_status: 'active',
                verification_status: 'unverified',
                domain: null,
                service: null,
                body_markdown: 'PostgreSQL is canonical.',
                properties: {},
                canonical_hash: currentHash,
              },
            ] as unknown as Row[],
          };
        if (sql.includes('INSERT INTO project_knowledge.knowledge_change_sets'))
          return { rows: [{ id: 'change-set-1' }] as unknown as Row[] };
        return { rows: [] };
      }
    }
    const client = new NoChangeClient();
    const store = new PgKnowledgeStore({
      connect: async () => client,
      query: (sql) => client.query(sql),
    });

    const result = await store.writeProjectKnowledge({
      projectKey: 'MC-Platform',
      actor: 'codex',
      message: 'Confirm SQL decision',
      reason: 'progress',
      idempotencyKey: 'write-2',
      changes: [
        {
          operation: 'patch',
          expectedHash: currentHash,
          item: { id: 'item-1' },
        },
      ],
    });

    expect(result).toMatchObject({
      revisionBefore: 3,
      revisionAfter: 3,
      summary: { unchanged: 1, updated: 0 },
      changes: [{ itemId: 'item-1', outcome: 'no_change' }],
    });
    expect(
      client.statements.some((sql) => sql.includes('SET db_revision')),
    ).toBe(false);
    expect(client.statements.some((sql) => sql.includes('outbox_jobs'))).toBe(
      false,
    );
  });
});
