import { describe, expect, it } from 'vitest';
import { acquireSingletonLock } from '../../src/worker/singleton-lock.js';

describe('knowledge worker singleton lock', () => {
  it('holds one PostgreSQL session until release', async () => {
    const statements: string[] = [];
    let released = false;
    const lock = await acquireSingletonLock(
      {
        connect: async () => ({
          query: async (sql: string) => {
            statements.push(sql);
            return { rows: [{ acquired: true }] };
          },
          release: () => {
            released = true;
          },
        }),
      },
      'worker',
    );
    expect(lock.acquired).toBe(true);
    expect(released).toBe(false);
    await lock.release();
    expect(statements.at(-1)).toContain('pg_advisory_unlock');
    expect(released).toBe(true);
  });
});
