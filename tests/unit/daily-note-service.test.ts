import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRegistry } from '../../src/config/registry.js';
import { DailyNoteService } from '../../src/services/daily-note-service.js';
import { FilesystemService } from '../../src/services/filesystem-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('daily note service', () => {
  it('creates and appends a configurable daily note without overwriting content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-daily-'));
    roots.push(root);
    const registry = await VaultRegistry.load(path.join(root, 'config.json'));
    await registry.register('notes', root, false, {
      directory: 'Journal',
      dateFormat: 'YYYY-MM-DD',
    });
    const files = new FilesystemService(registry);
    const service = new DailyNoteService(registry, files);
    const date = new Date(2026, 6, 30);

    await service.append('notes', 'first', date);
    await service.append('notes', 'second', date);
    expect(
      await readFile(path.join(root, 'Journal', '2026-07-30.md'), 'utf8'),
    ).toBe('firstsecond');
  });
});
