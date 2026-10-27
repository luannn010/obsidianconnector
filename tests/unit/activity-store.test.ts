import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PgActivityHandler,
  type ActivityWorktreeResolver,
} from '../../src/activity/pg-activity-handler.js';
import type {
  PgClientLike,
  PgPoolLike,
  PgQueryResult,
} from '../../src/knowledge/pg-store.js';
import type {
  KnowledgeWriteResult,
  WriteProjectKnowledgeInput,
} from '../../src/knowledge/types.js';

class ActivityClient implements PgClientLike {
  readonly values: unknown[][] = [];
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.values.push(values);
    if (sql.includes('FROM project_knowledge.projects'))
      return { rows: [{ project_id: 'project-1' }] as unknown as Row[] };
    if (sql.includes('FROM project_knowledge.repositories'))
      return { rows: [{ id: 'repository-1' }] as unknown as Row[] };
    if (sql.includes('INSERT INTO project_knowledge.worktrees'))
      return { rows: [{ id: 'worktree-1' }] as unknown as Row[] };
    if (sql.includes("state='active'"))
      return { rows: [{ id: 'snapshot-1' }] as unknown as Row[] };
    if (sql.includes('INSERT INTO project_knowledge.agent_tasks'))
      return { rows: [{ id: 'task-row-1' }] as unknown as Row[] };
    if (sql.includes('INSERT INTO project_knowledge.file_activity_events'))
      return { rows: [{ id: 'event-1' }] as unknown as Row[] };
    return { rows: [] };
  }
  release() {}
}

class HandoffClient extends ActivityClient {
  constructor(
    private readonly changedFiles: string[],
    private readonly existingHandoffId?: string,
  ) {
    super();
  }
  override async query<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(sql: string, values: unknown[] = []): Promise<PgQueryResult<Row>> {
    if (sql.includes('AS changed_files'))
      return {
        rows: [
          {
            task_name: 'Observer grants',
            status: 'completed',
            branch: 'ptolemy/observer',
            changed_files: this.changedFiles,
            changed_count: String(this.changedFiles.length),
            stale_refs: ['knowledge:item-1:v2'],
          },
        ] as unknown as Row[],
      };
    if (sql.includes('stable_key=$2'))
      return {
        rows: this.existingHandoffId
          ? ([{ id: this.existingHandoffId }] as unknown as Row[])
          : [],
      };
    return super.query<Row>(sql, values);
  }
}

describe('PostgreSQL agent activity handler', () => {
  const resolver: ActivityWorktreeResolver = {
    resolve: async () => ({
      root: 'C:\\repo',
      branch: 'ptolemy/observer',
      head: 'abc123',
      dirtyHash: null,
    }),
  };

  async function endSession(
    client: ActivityClient,
    writes: WriteProjectKnowledgeInput[],
    write?: () => Promise<never>,
  ) {
    const pool: PgPoolLike = {
      connect: async () => client,
      query: (sql, values) => client.query(sql, values),
    };
    const handler = new PgActivityHandler(pool, resolver, {
      writeProjectKnowledge: async (input) => {
        writes.push(input);
        if (write) return write();
        return {} as KnowledgeWriteResult;
      },
    });
    const result = await handler.record({
      projectKey: 'Test-Project',
      agent: 'codex',
      sessionId: 'task-1',
      lifecycle: 'session_end',
      cwd: 'C:\\repo',
      events: [],
    });
    await handler.flushHandoffs();
    return result;
  }

  it('writes a durable handoff item when a session that changed files ends', async () => {
    const writes: WriteProjectKnowledgeInput[] = [];
    await endSession(new HandoffClient(['src/a.ts', 'src/b.ts']), writes);
    expect(writes).toHaveLength(1);
    const write = writes[0]!;
    expect(write).toMatchObject({
      projectKey: 'Test-Project',
      actor: 'codex',
      taskId: 'task-1',
      reason: 'progress',
      changes: [
        {
          operation: 'create',
          item: {
            kind: 'handoff',
            stableKey: 'handoff:codex:task-1',
            title: 'Handoff from codex: Observer grants',
            deliveryStatus: 'completed',
          },
        },
      ],
    });
    expect(write.idempotencyKey).toMatch(
      /^handoff:codex:task-1:[0-9a-f]{16}$/u,
    );
    const body = write.changes[0]!.item.bodyMarkdown!;
    expect(body).toContain('- src/a.ts');
    expect(body).toContain('ptolemy/observer');
    expect(body).toContain('knowledge:item-1:v2');
  });

  it('patches the existing handoff item for the same session', async () => {
    const writes: WriteProjectKnowledgeInput[] = [];
    await endSession(new HandoffClient(['src/a.ts'], 'item-9'), writes);
    expect(writes[0]!.changes[0]).toMatchObject({
      operation: 'patch',
      item: { id: 'item-9' },
    });
  });

  it('skips the handoff when the session changed no files and survives write failures', async () => {
    const writes: WriteProjectKnowledgeInput[] = [];
    await endSession(new HandoffClient([]), writes);
    expect(writes).toHaveLength(0);
    await expect(
      endSession(new HandoffClient(['src/a.ts']), writes, async () => {
        throw new Error('database unavailable');
      }),
    ).resolves.toEqual({ accepted: 0, ignored: 0 });
  });

  it('stores normalized repository paths and ignores excluded activity', async () => {
    const client = new ActivityClient();
    const pool: PgPoolLike = {
      connect: async () => client,
      query: (sql, values) => client.query(sql, values),
    };
    const handler = new PgActivityHandler(pool, resolver);
    const result = await handler.record({
      projectKey: 'Test-Project',
      agent: 'codex',
      sessionId: 'task-1',
      taskName: 'Observer grants',
      cwd: 'C:\\repo',
      events: [
        {
          action: 'edit',
          path: 'services/observer/server/database.js',
          captureMethod: 'structured_tool',
          confidence: 'high',
          toolCallId: 'tool-1',
        },
        {
          action: 'read',
          path: 'node_modules/pg/index.js',
          captureMethod: 'structured_tool',
          confidence: 'high',
          toolCallId: 'tool-2',
        },
      ],
    });
    expect(result).toEqual({ accepted: 1, ignored: 1 });
    expect(client.values.flat()).toContain(
      'services/observer/server/database.js',
    );
    expect(client.values.flat()).not.toContain('node_modules/pg/index.js');
  });

  it('returns only required stale documentation linked to files changed by the task', async () => {
    const pool: PgPoolLike = {
      connect: async () => {
        throw new Error('not used');
      },
      query: async <Row extends Record<string, unknown>>(
        sql: string,
      ): Promise<PgQueryResult<Row>> => ({
        rows: sql.includes('task_file_rollups')
          ? ([{ ref: 'knowledge:item-1:v2' }] as unknown as Row[])
          : [],
      }),
    };
    const result = await new PgActivityHandler(pool, resolver).gate({
      projectKey: 'Test-Project',
      agent: 'claude',
      sessionId: 'task-2',
    });
    expect(result).toEqual({
      blocked: true,
      refs: ['knowledge:item-1:v2'],
    });
  });
  it('summarizes the other agent recent tasks, changed files, and blockers', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const pool: PgPoolLike = {
      connect: async () => {
        throw new Error('not used');
      },
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values: unknown[] = [],
      ): Promise<PgQueryResult<Row>> => {
        queries.push({ sql, values });
        if (sql.includes('changed_by_task'))
          return {
            rows: [
              {
                agent: 'codex',
                task_name: 'Add metrics loader',
                status: 'completed',
                last_seen_at: new Date('2026-10-27T01:00:00.000Z'),
                branch: 'feat/mcp-metrics',
                changed_files: ['src/metrics-loader.ts', 'src/server.ts'],
                changed_count: '3',
                stale_refs: ['knowledge:item-1:v2'],
              },
            ] as unknown as Row[],
          };
        if (sql.includes("kind='blocker'"))
          return { rows: [{ title: 'Heartbeat stale' }] as unknown as Row[] };
        return { rows: [] };
      },
    };
    const result = await new PgActivityHandler(pool, resolver).handoff({
      projectKey: 'Test-Project',
      agent: 'claude',
      cwd: 'C:\\repo\\src',
    });
    expect(result).toEqual({
      tasks: [
        {
          agent: 'codex',
          taskName: 'Add metrics loader',
          status: 'completed',
          lastSeenAt: '2026-10-27T01:00:00.000Z',
          branch: 'feat/mcp-metrics',
          changedFiles: ['src/metrics-loader.ts', 'src/server.ts'],
          moreFiles: 1,
          staleRefs: ['knowledge:item-1:v2'],
        },
      ],
      blockers: ['Heartbeat stale'],
    });
    const taskQuery = queries.find((query) =>
      query.sql.includes('changed_by_task'),
    )!;
    expect(taskQuery.values).toEqual([
      'Test-Project',
      'codex',
      path.resolve('C:\\repo'),
    ]);
  });

  it('resolves a missing project key from the repository root path', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const client = new ActivityClient();
    const pool: PgPoolLike = {
      connect: async () => client,
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values: unknown[] = [],
      ): Promise<PgQueryResult<Row>> => {
        queries.push({ sql, values });
        if (sql.includes('AS project_key'))
          return {
            rows: [
              { project_id: 'project-1', project_key: 'Test-Project' },
            ] as unknown as Row[],
          };
        return client.query<Row>(sql, values);
      },
    };

    const result = await new PgActivityHandler(pool, resolver).record({
      agent: 'codex',
      sessionId: 'task-path',
      cwd: 'C:\\repo\\src',
      events: [],
    });

    expect(result).toEqual({ accepted: 0, ignored: 0 });
    const resolution = queries.find((query) =>
      query.sql.includes('AS project_key'),
    )!;
    expect(resolution.sql).toContain('lower(repository.root_path)=lower($1)');
    expect(resolution.sql).toContain('lower(worktree.path)=lower($1)');
    expect(resolution.values).toEqual([path.resolve('C:\\repo')]);
  });

  it('ignores events for an unknown project without opening a transaction', async () => {
    const pool: PgPoolLike = {
      connect: async () => {
        throw new Error('should not connect');
      },
      query: async () => ({ rows: [] }),
    };

    await expect(
      new PgActivityHandler(pool, resolver).record({
        agent: 'claude',
        sessionId: 'task-unknown',
        cwd: 'C:\\repo',
        events: [
          {
            action: 'edit',
            path: 'src/index.ts',
            captureMethod: 'structured_tool',
            confidence: 'high',
          },
        ],
      }),
    ).resolves.toEqual({ accepted: 0, ignored: 1 });
  });

  it('reports the last event time per agent for the resolved worktree', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const pool: PgPoolLike = {
      connect: async () => {
        throw new Error('not used');
      },
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values: unknown[] = [],
      ): Promise<PgQueryResult<Row>> => {
        queries.push({ sql, values });
        if (sql.includes('AS project_key'))
          return {
            rows: [
              { project_id: 'project-1', project_key: 'Test-Project' },
            ] as unknown as Row[],
          };
        return {
          rows: [
            {
              claude_last_seen_at: new Date('2026-10-27T01:00:00.000Z'),
              codex_last_seen_at: null,
            },
          ] as unknown as Row[],
        };
      },
    };

    await expect(
      new PgActivityHandler(pool, resolver).status({ cwd: 'C:\\repo\\src' }),
    ).resolves.toEqual({
      projectKey: 'Test-Project',
      lastEventAt: {
        claude: '2026-10-27T01:00:00.000Z',
        codex: null,
      },
    });
    expect(queries.at(-1)?.values).toEqual([
      'project-1',
      path.resolve('C:\\repo'),
    ]);
  });
});
