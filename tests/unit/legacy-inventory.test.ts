import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inventoryLegacyNotes } from '../../src/worker/legacy-inventory.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

describe('legacy vault inventory', () => {
  it('hashes every note while omitting security-denied bodies', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'legacy-vault-'));
    roots.push(root);
    await mkdir(path.join(root, 'Plans'));
    await writeFile(
      path.join(root, 'Plans', 'Task.md'),
      '---\nstatus: active\n---\n# Task\n[[Home]]',
    );
    await writeFile(
      path.join(root, 'Credentials and Environment Map.md'),
      '# Locations\nsecret-ish',
    );
    const notes = await inventoryLegacyNotes(root);
    expect(notes).toHaveLength(2);
    expect(
      notes.find((note) => note.originalPath === 'Plans/Task.md'),
    ).toMatchObject({
      frontmatter: { status: 'active' },
      outboundLinks: ['Home'],
      bodyMarkdown: expect.stringContaining('# Task'),
    });
    expect(
      notes.find((note) => note.originalPath.includes('Credentials')),
    ).toMatchObject({
      bodyMarkdown: undefined,
      contentOmittedReason: 'sensitive-path',
      rawHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
