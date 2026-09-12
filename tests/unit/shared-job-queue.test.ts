import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { SharedJobQueue } from '../../src/worker/shared-job-queue.js';

describe('SharedJobQueue', () => {
  it('deduplicates source requests by project and worktree', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [{ id: 'job-1', inserted: false }] };
      }),
    } as unknown as Pool;
    const queue = new SharedJobQueue(pool);
    await expect(
      queue.enqueueSourceSync('project-1', 'worktree-1', 'on_demand'),
    ).resolves.toEqual({ jobId: 'job-1', created: false });
    expect(queries[0]?.values).toContain('source-sync:worktree-1');
    expect(queries[0]?.sql).toContain('ON CONFLICT');
  });

  it('claims fairly with capabilities, leases, and skip-locked recovery', async () => {
    const client = {
      query: vi.fn(async (sql: string) =>
        sql.includes('RETURNING job.')
          ? { rows: [{ id: 'job-1', project_id: 'p1', job_type: 'embed_chunk', payload: {} }] }
          : { rows: [] },
      ),
      release: vi.fn(),
    };
    const queue = new SharedJobQueue({ connect: async () => client } as unknown as Pool);
    await expect(queue.claim(['embedding'], 'worker-1', 2, 120)).resolves.toHaveLength(1);
    const sql = client.query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('row_number() OVER (PARTITION BY');
    expect(sql).toContain('fair.project_rank=1');
    expect(sql).toContain('SKIP LOCKED');
    expect(sql).toContain('lease_expires_at');
  });

  it('requeues expired portable jobs but never changes their required capability', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 2 })) } as unknown as Pool;
    const queue = new SharedJobQueue(pool);
    await expect(queue.recoverExpiredLeases()).resolves.toBe(2);
    const [sql] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sql).toContain("state='pending'");
    expect(sql).not.toContain('required_capability=');
  });
});
