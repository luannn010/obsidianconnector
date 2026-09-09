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
            rows: [{ state: 'current' }] as unknown as Row[],
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
      pendingJobs: 0,
      failedJobs: 0,
    });
    expect(result.topIssues).toEqual([]);
    expect(result.topSuggestedActions).toEqual([]);
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
