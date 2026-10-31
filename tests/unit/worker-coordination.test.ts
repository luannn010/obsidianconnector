import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { HourlySourceScheduler } from '../../src/worker/job-scheduler.js';
import {
  createWorkerInstanceId,
  WorkerInstanceRegistry,
} from '../../src/worker/worker-instance-registry.js';

describe('worker coordination', () => {
  it('keeps host-network containers with the same hostname and PID distinct', () => {
    const first = createWorkerInstanceId('debian', 'shared-host', 1);
    const second = createWorkerInstanceId('debian', 'shared-host', 1);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^debian-shared-host-1-[0-9a-f-]{36}$/u);
  });

  it('schedules each registered worktree only when the hourly receipt is due', async () => {
    const enqueueSourceSync = vi.fn(async () => ({
      jobId: 'j1',
      created: true,
    }));
    const pool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ scheduler_key: 'source-sync-hourly' }],
        })
        .mockResolvedValueOnce({
          rows: [
            { project_id: 'p1', worktree_id: 'w1' },
            { project_id: 'p2', worktree_id: 'w2' },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
    } as unknown as Pool;
    const scheduler = new HourlySourceScheduler(pool, {
      enqueueSourceSync,
    } as never);
    await expect(scheduler.runIfDue('debian-1')).resolves.toBe(2);
    await expect(scheduler.runIfDue('debian-1')).resolves.toBe(0);
    expect(enqueueSourceSync).toHaveBeenCalledTimes(2);
  });

  it('records instance capabilities and detects a fresh Debian embedding worker', async () => {
    const pool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }),
    } as unknown as Pool;
    const registry = new WorkerInstanceRegistry(
      pool,
      'windows-1',
      'windows',
      ['source-sync'],
      'release',
    );
    await registry.heartbeat();
    await expect(registry.hasFreshDebianEmbeddingWorker()).resolves.toBe(true);
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls
      .map(([statement]) => statement)
      .join('\n');
    expect(sql).toContain('worker_instances');
    expect(sql).toContain("host_kind='debian'");
  });
});
