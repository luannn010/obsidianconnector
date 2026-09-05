import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectionHash } from '../../src/knowledge/hash.js';
import {
  publishProjection,
  renderManagedNote,
} from '../../src/worker/projection.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

describe('managed Obsidian projections', () => {
  it('renders a stable body hash and detects manual drift without overwriting', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'projection-'));
    roots.push(root);
    const rendered = renderManagedNote({
      viewId: 'dashboard',
      projectId: 'p1',
      viewType: 'dashboard',
      dbRevision: 2,
      gitRevision: 'abc',
      body: '# Dashboard\nCurrent',
    });
    const first = await publishProjection(
      root,
      'Published/00 - Project Dashboard.md',
      rendered,
    );
    expect(first.state).toBe('current');
    expect(first.observedHash).toBe(projectionHash(rendered));
    const target = path.join(root, 'Published', '00 - Project Dashboard.md');

    const nextRendered = renderManagedNote({
      viewId: 'dashboard',
      projectId: 'p1',
      viewType: 'dashboard',
      dbRevision: 3,
      gitRevision: 'def',
      body: '# Dashboard\nUpdated',
    });
    const recovered = await publishProjection(
      root,
      'Published/00 - Project Dashboard.md',
      nextRendered,
      'stale-database-hash',
      {
        desiredHash: projectionHash(nextRendered),
        observedHash: first.observedHash,
        preservedPath: 'previous-conflict.md',
      },
    );
    expect(recovered.state).toBe('current');
    expect(await readFile(target, 'utf8')).toContain('Updated');

    await writeFile(target, `${await readFile(target, 'utf8')}\nmanual`);
    const second = await publishProjection(
      root,
      'Published/00 - Project Dashboard.md',
      nextRendered,
      recovered.observedHash,
    );
    expect(second.state).toBe('drifted');
    expect(second.conflictCreated).toBe(true);
    expect(await readFile(target, 'utf8')).toContain('manual');
    expect(await readFile(second.preservedPath!, 'utf8')).toContain('manual');

    const repeated = await publishProjection(
      root,
      'Published/00 - Project Dashboard.md',
      nextRendered,
      recovered.observedHash,
      {
        desiredHash: projectionHash(nextRendered),
        observedHash: second.observedHash,
        preservedPath: second.preservedPath!,
      },
    );
    expect(repeated).toEqual({
      state: 'drifted',
      observedHash: second.observedHash,
      preservedPath: second.preservedPath,
      conflictCreated: false,
    });
    expect(await readdir(path.join(root, 'Inbox', 'Conflicts'))).toHaveLength(
      1,
    );
  });
});
