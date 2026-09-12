import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { QueueWorkerService } from '../../src/worker/queue-worker-service.js';

describe('QueueWorkerService', () => {
  it('records a compact heartbeat and cumulative queue counters', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes('FROM project_knowledge.projects'))
          return { rows: [{ project_id: 'project-1' }] };
        if (sql.includes('FILTER')) return { rows: [{ pending: 12, failed: 0 }] };
        return { rows: [] };
      }),
    } as unknown as Pool;
    const processor = {
      processBatch: vi.fn(async () => ({
        claimed: 5, embedded: 2, applied: 5, reused: 3,
        retired: 7, completed: 1, failed: 0,
      })),
    };
    const service = new QueueWorkerService(pool, processor, {
      projectKey: 'MC-Platform', releaseId: 'release-1', workerRole: 'embedding-queue',
    });

    await service.runOnce(50);

    const heartbeat = queries.find(({ sql }) => sql.includes('worker_health'))!;
    expect(heartbeat.values).toContain('release-1');
    expect(heartbeat.values).toContain(12);
    expect(heartbeat.sql).toContain('processed_count=project_knowledge.worker_health.processed_count');
  });
});
