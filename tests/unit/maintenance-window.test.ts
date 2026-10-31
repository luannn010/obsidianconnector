import { describe, expect, it } from 'vitest';
import type { PgPoolLike } from '../../src/knowledge/pg-store.js';
import {
  claimMaintenanceWindow,
  runMaintenanceWithLease,
} from '../../src/worker/maintenance-window.js';

describe('maintenance scheduling', () => {
  it('runs a granted lease and schedules the next cycle only on success', async () => {
    const statements: string[] = [];
    const pool = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [{ task_key: 'daily' }] };
      },
    } as unknown as PgPoolLike;
    expect(
      await runMaintenanceWithLease(pool, 'daily', 86400_000, async () => 7),
    ).toBe(7);
    expect(statements.at(-1)).toContain('lease_owner=NULL');
  });
  it('releases a failed cycle with a short retry interval', async () => {
    let retry: unknown;
    const pool = {
      query: async (_sql: string, values?: unknown[]) => {
        retry = values?.[2];
        return { rows: [{ task_key: 'daily' }] };
      },
    } as unknown as PgPoolLike;
    await expect(
      runMaintenanceWithLease(pool, 'daily', 86400_000, async () => {
        throw new Error('cleanup failed');
      }),
    ).rejects.toThrow('cleanup failed');
    expect(retry).toBe(60_000);
  });
  it('skips a replica when the database did not grant the next maintenance window', async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as PgPoolLike;
    expect(
      await claimMaintenanceWindow(pool, 'embedding-orphans', 600_000),
    ).toBe(false);
  });
  it('runs when a due maintenance window was atomically claimed', async () => {
    let parameters: unknown[] | undefined;
    const pool = {
      query: async (_sql: string, values?: unknown[]) => {
        parameters = values;
        return { rows: [{ task_key: 'embedding-orphans' }] };
      },
    } as unknown as PgPoolLike;
    expect(
      await claimMaintenanceWindow(pool, 'embedding-orphans', 600_000),
    ).toBe(true);
    expect(parameters).toEqual(['embedding-orphans', 600_000]);
  });
});
