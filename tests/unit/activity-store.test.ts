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

describe('PostgreSQL agent activity handler', () => {
  const resolver: ActivityWorktreeResolver = {
    resolve: async () => ({
      root: 'C:\\repo',
      branch: 'ptolemy/observer',
      head: 'abc123',
      dirtyHash: null,
    }),
  };

  it('stores normalized repository paths and ignores excluded activity', async () => {
    const client = new ActivityClient();
    const pool: PgPoolLike = {
      connect: async () => client,
      query: (sql, values) => client.query(sql, values),
    };
    const handler = new PgActivityHandler(pool, resolver);
    const result = await handler.record({
      projectKey: 'MC-Platform',
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
      projectKey: 'MC-Platform',
      agent: 'claude',
      sessionId: 'task-2',
    });
    expect(result).toEqual({
      blocked: true,
      refs: ['knowledge:item-1:v2'],
    });
  });
});
