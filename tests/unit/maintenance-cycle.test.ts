import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { runMaintenanceCycle } from '../../src/worker/maintenance-cycle.js';

vi.mock('../../src/worker/snapshot-cleanup.js', () => ({
  pruneSupersededSnapshots: vi
    .fn()
    .mockRejectedValue(new Error('statement timeout')),
  pruneSupersededSnapshotPayload: vi
    .fn()
    .mockResolvedValueOnce({ prunedSnapshots: 3 })
    .mockResolvedValueOnce({ prunedSnapshots: 0 }),
}));

describe('runMaintenanceCycle', () => {
  it('reports cleanup timeout and returns so embedding work can continue', async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ project_key: 'MC-Platform' }, { project_key: 'other' }],
      })),
    } as unknown as Pool;
    const queue = { recoverExpiredLeases: vi.fn(async () => 2) };
    const onError = vi.fn();
    await expect(runMaintenanceCycle(pool, queue, 7, onError)).resolves.toBe(5);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'statement timeout' }));
  });
});
