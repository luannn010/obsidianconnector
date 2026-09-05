export interface SingletonLockPool {
  connect(): Promise<{
    query(
      sql: string,
      values?: unknown[],
    ): Promise<{ rows: Array<{ acquired?: boolean }> }>;
    release(): void;
  }>;
}

export async function acquireSingletonLock(
  pool: SingletonLockPool,
  name: string,
): Promise<{ acquired: boolean; release(): Promise<void> }> {
  const client = await pool.connect();
  const acquired = Boolean(
    (
      await client.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [name],
      )
    ).rows[0]?.acquired,
  );
  if (!acquired) client.release();
  let active = acquired;
  return {
    acquired,
    release: async () => {
      if (!active) return;
      active = false;
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1)) AS acquired', [name])
        .finally(() => client.release());
    },
  };
}
