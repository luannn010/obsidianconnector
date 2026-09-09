import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { afterEach, describe, expect, it } from 'vitest';
import { projectionHash } from '../../src/knowledge/hash.js';
import {
  publishProjection,
  removeProjection,
  renderManagedNote,
} from '../../src/worker/projection.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

describe('managed Obsidian projections', () => {
  it('includes domain sync metadata in managed frontmatter', () => {
    const rendered = renderManagedNote({
      viewId: 'domain:Server control',
      projectId: 'p1',
      viewType: 'domain',
      dbRevision: 9,
      gitRevision: 'head',
      metadata: {
        branch: 'feature/rcon',
        current_commit: 'head',
        current_dirty_hash: 'dirty',
        domain: 'Server control',
        last_synced_commit: 'base',
        snapshot_id: 'snapshot-1',
        sync_status: 'stale',
        worktree: 'C:/repo',
      },
      body: '# Server control',
      generatedAt: '2026-09-06T00:00:00.000Z',
    });

    expect(matter(rendered).data).toMatchObject({
      branch: 'feature/rcon',
      current_commit: 'head',
      current_dirty_hash: 'dirty',
      domain: 'Server control',
      last_synced_commit: 'base',
      snapshot_id: 'snapshot-1',
      sync_status: 'stale',
      worktree: 'C:/repo',
    });
  });

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

  it('removes retired managed notes and preserves manual edits in conflicts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'projection-retire-'));
    roots.push(root);
    const rendered = renderManagedNote({
      viewId: 'agent-task:codex:old-task',
      projectId: 'p1',
      viewType: 'agent-task',
      dbRevision: 2,
      body: '# Old task',
    });
    const relativePath = 'Published/02 - Delivery/Tasks/old-task.md';
    const published = await publishProjection(root, relativePath, rendered);

    const removed = await removeProjection(
      root,
      relativePath,
      published.observedHash,
    );
    expect(removed).toEqual({ removed: true });
    await expect(readFile(path.join(root, relativePath), 'utf8')).rejects.toThrow();

    await publishProjection(root, relativePath, rendered);
    const target = path.join(root, relativePath);
    await writeFile(target, `${rendered}\nmanual note`);
    const preserved = await removeProjection(root, relativePath, published.observedHash);
    expect(preserved.preservedPath).toContain('Inbox');
    expect(await readFile(preserved.preservedPath!, 'utf8')).toContain('manual note');
  });
});
