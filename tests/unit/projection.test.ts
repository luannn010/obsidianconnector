import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    await writeFile(target, `${await readFile(target, 'utf8')}\nmanual`);
    const second = await publishProjection(
      root,
      'Published/00 - Project Dashboard.md',
      rendered,
      first.observedHash,
    );
    expect(second.state).toBe('drifted');
    expect(await readFile(target, 'utf8')).toContain('manual');
    expect(await readFile(second.preservedPath!, 'utf8')).toContain('manual');
  });
});
