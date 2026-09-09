import { describe, expect, it } from 'vitest';
import { drainQueueBatches } from '../../src/worker/drain-queue.js';

describe('queue batch draining', () => {
  it('continues through full batches and stops after the partial batch', async () => {
    const batches = [50, 50, 3];
    let calls = 0;
    const total = await drainQueueBatches(async () => batches[calls++]!, 50);

    expect(total).toBe(103);
    expect(calls).toBe(3);
  });

  it('stops immediately when the queue is empty', async () => {
    let calls = 0;
    const total = await drainQueueBatches(async () => {
      calls += 1;
      return 0;
    }, 50);

    expect(total).toBe(0);
    expect(calls).toBe(1);
  });

  it('stops at the configured per-cycle limit even when the queue remains full', async () => {
    const requested: number[] = [];
    const total = await drainQueueBatches(
      async (limit) => {
        requested.push(limit);
        return limit;
      },
      50,
      100,
    );

    expect(total).toBe(100);
    expect(requested).toEqual([50, 50]);
  });
});
