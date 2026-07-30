import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRegistry } from '../../src/config/registry.js';
import { FilesystemService } from '../../src/services/filesystem-service.js';

const roots: string[] = [];

async function setup(
  readOnly = false,
): Promise<{ root: string; service: FilesystemService }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-files-'));
  roots.push(root);
  const registry = await VaultRegistry.load(path.join(root, 'config.json'));
  await registry.register('test', root, readOnly);
  return { root, service: new FilesystemService(registry) };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('filesystem service', () => {
  it('creates, reads, updates, and appends Markdown notes with hashes', async () => {
    const { root, service } = await setup();
    const created = await service.createNote('test', 'Projects/plan.md', 'one');
    expect(created.path).toBe('Projects/plan.md');
    expect(created.contentHash).toHaveLength(64);
    expect(await readFile(path.join(root, 'Projects', 'plan.md'), 'utf8')).toBe(
      'one',
    );
    await expect(
      service.createNote('test', 'Projects/plan.md', 'two'),
    ).rejects.toThrow('already exists');
    const updated = await service.updateNote(
      'test',
      'Projects/plan.md',
      'two',
      created.contentHash,
    );
    await expect(
      service.updateNote(
        'test',
        'Projects/plan.md',
        'three',
        created.contentHash,
      ),
    ).rejects.toThrow('hash');
    const appended = await service.appendNote(
      'test',
      'Projects/plan.md',
      '\nthree',
    );
    expect(appended.contentHash).not.toBe(updated.contentHash);
    expect((await service.readNote('test', 'Projects/plan.md')).content).toBe(
      'two\nthree',
    );
  });

  it('lists notes and directories while excluding hidden and non-Markdown files', async () => {
    const { root, service } = await setup();
    await mkdir(path.join(root, 'Sub', '.hidden'), { recursive: true });
    await writeFile(path.join(root, 'Sub', 'a.md'), '# A');
    await writeFile(path.join(root, 'Sub', 'b.txt'), 'ignore');
    await writeFile(path.join(root, 'Sub', '.hidden', 'c.md'), 'ignore');
    expect(
      (await service.listNotes('test', 'Sub')).map((entry) => entry.path),
    ).toEqual(['Sub/a.md']);
    expect(
      (await service.listDirectory('test', 'Sub')).map((entry) => entry.path),
    ).toEqual(['Sub/a.md']);
  });

  it('moves deleted notes to a collision-safe trash path and rejects move collisions', async () => {
    const { service } = await setup();
    await service.createNote('test', 'a.md', 'a');
    await service.createNote('test', 'b.md', 'b');
    await expect(service.moveNote('test', 'a.md', 'b.md')).rejects.toThrow(
      'already exists',
    );
    await service.deleteNote('test', 'a.md');
    expect(
      (await service.listNotes('test')).map((entry) => entry.path),
    ).toEqual(['b.md']);
    await expect(service.listDirectory('test', '.trash')).rejects.toThrow();
    const trashEntries = await service.listTrash('test');
    expect(trashEntries).toHaveLength(1);
  });

  it('overwrites an existing move destination only when explicitly allowed', async () => {
    const { service } = await setup();
    await service.createNote('test', 'source.md', 'source');
    await service.createNote('test', 'destination.md', 'destination');

    await service.moveNote('test', 'source.md', 'destination.md', true);

    expect((await service.readNote('test', 'destination.md')).content).toBe(
      'source',
    );
  });

  it('enforces read-only vaults for every mutation', async () => {
    const { service } = await setup(true);
    await expect(
      service.createNote('test', 'readme.md', 'nope'),
    ).rejects.toThrow('read-only');
    await expect(service.createDirectory('test', 'folder')).rejects.toThrow(
      'read-only',
    );
  });
});
