import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRegistry } from '../../src/config/registry.js';
import { SearchService } from '../../src/services/search-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('search service', () => {
  it('searches filenames, body, tags, and frontmatter with bounded excerpts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-search-'));
    roots.push(root);
    await mkdir(path.join(root, '.obsidian'));
    await writeFile(
      path.join(root, 'alpha.md'),
      '---\ntags: [important]\nstatus: open\n---\nThis is searchable content.',
    );
    await writeFile(path.join(root, 'beta.md'), 'unrelated');
    await writeFile(path.join(root, '.obsidian', 'hidden.md'), 'searchable');
    const registry = await VaultRegistry.load(path.join(root, 'config.json'));
    await registry.register('notes', root);
    const service = new SearchService(registry);

    expect(
      (await service.search('notes', 'important')).map((match) => match.path),
    ).toEqual(['alpha.md']);
    expect(await service.search('notes', 'searchable', 1)).toHaveLength(1);
    expect(await service.search('notes', 'missing')).toEqual([]);
  });
});
