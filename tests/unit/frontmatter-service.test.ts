import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRegistry } from '../../src/config/registry.js';
import { FilesystemService } from '../../src/services/filesystem-service.js';
import { FrontmatterService } from '../../src/services/frontmatter-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('frontmatter service', () => {
  it('reads and merges YAML properties without replacing the note body', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'obsidian-mcp-frontmatter-'),
    );
    roots.push(root);
    const registry = await VaultRegistry.load(path.join(root, 'config.json'));
    await registry.register('notes', root);
    const files = new FilesystemService(registry);
    await files.createNote(
      'notes',
      'note.md',
      '---\ntags: [one]\nstatus: open\n---\nBody stays here.',
    );
    const service = new FrontmatterService(files);

    expect((await service.get('notes', 'note.md')).status).toBe('open');
    await service.update('notes', 'note.md', {
      status: 'done',
      aliases: ['n'],
    });
    const content = await readFile(path.join(root, 'note.md'), 'utf8');
    expect(content).toContain('Body stays here.');
    expect((await service.get('notes', 'note.md')).status).toBe('done');
    expect((await service.get('notes', 'note.md')).aliases).toEqual(['n']);
  });
});
