import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRegistry } from '../../src/config/registry.js';
import { FilesystemService } from '../../src/services/filesystem-service.js';
import { ProjectContextService } from '../../src/services/project-context-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeService(): Promise<{
  root: string;
  service: ProjectContextService;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-context-'));
  roots.push(root);
  const registry = await VaultRegistry.load(path.join(root, 'config.json'));
  await registry.register('testing', root);
  return {
    root,
    service: new ProjectContextService(
      registry,
      new FilesystemService(registry),
    ),
  };
}

describe('project context service', () => {
  it('returns canonical project notes and reports missing notes without failing', async () => {
    const { root, service } = await makeService();
    await writeFile(
      path.join(root, '00 - Project Home.md'),
      '# Testing\n\nCurrent focus: connector context.\n',
    );
    await writeFile(
      path.join(root, '06 - Tasks.md'),
      '- [ ] Add context tool\n- [x] Define vault layout\n',
    );

    const context = await service.getContext('testing', 5000);

    expect(context.vault).toBe('testing');
    expect(
      context.notes.find((note) => note.path === '00 - Project Home.md'),
    ).toMatchObject({
      exists: true,
      content: expect.stringContaining('connector context'),
    });
    expect(
      context.notes.find((note) => note.path === '01 - Brief.md'),
    ).toMatchObject({ exists: false });
  });

  it('extracts open and completed tasks plus recent daily notes', async () => {
    const { root, service } = await makeService();
    await mkdir(path.join(root, 'Daily'));
    await writeFile(
      path.join(root, '06 - Tasks.md'),
      '- [ ] Add context tool\n- [x] Define vault layout\n',
    );
    await writeFile(
      path.join(root, '04 - Decisions.md'),
      '## 2026-07-31 — Context\n\nUse bounded read-only tools.\n',
    );
    await writeFile(
      path.join(root, 'Daily', '2026-07-31.md'),
      'Worked on project context extraction.\n',
    );

    const activity = await service.getActivity('testing', 5, 5000);

    expect(activity.tasks).toEqual([
      { completed: false, text: 'Add context tool', source: '06 - Tasks.md' },
      { completed: true, text: 'Define vault layout', source: '06 - Tasks.md' },
    ]);
    expect(activity.decisions[0]).toMatchObject({
      source: '04 - Decisions.md',
      content: expect.stringContaining('Use bounded read-only tools'),
    });
    expect(activity.dailyNotes[0]).toMatchObject({
      source: 'Daily/2026-07-31.md',
      content: expect.stringContaining('context extraction'),
    });
  });
});
