import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { drainActivitySpool } from '../../src/activity/spool.js';

describe('activity spool replay', () => {
  it('replays valid entries once and removes them from the spool', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'activity-spool-'));
    const spool = path.join(root, 'activity.ndjson');
    await writeFile(
      spool,
      `${JSON.stringify({ sessionId: 'one' })}\n${JSON.stringify({ sessionId: 'two' })}\n`,
    );
    const seen: unknown[] = [];
    const result = await drainActivitySpool(spool, async (entry) => {
      seen.push(entry);
    });
    expect(result).toEqual({ replayed: 2, retained: 0, invalid: 0 });
    expect(seen).toHaveLength(2);
    expect(await readFile(spool, 'utf8')).toBe('');
  });

  it('retains failed entries without replaying successful entries again', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'activity-spool-'));
    const spool = path.join(root, 'activity.ndjson');
    await writeFile(
      spool,
      `${JSON.stringify({ sessionId: 'ok' })}\n${JSON.stringify({ sessionId: 'retry' })}\n`,
    );
    const result = await drainActivitySpool(spool, async (entry) => {
      if ((entry as { sessionId?: string }).sessionId === 'retry')
        throw new Error('database offline');
    });
    expect(result).toEqual({ replayed: 1, retained: 1, invalid: 0 });
    expect(await readFile(spool, 'utf8')).toBe(
      `${JSON.stringify({ sessionId: 'retry' })}\n`,
    );
  });
});
