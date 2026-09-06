import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRegistry } from '../../src/config/registry.js';
import { FilesystemService } from '../../src/services/filesystem-service.js';
import { ProjectBootstrapService } from '../../src/services/project-bootstrap-service.js';
import { ProjectMappingService } from '../../src/services/project-mapping-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeService(): Promise<{
  root: string;
  project: string;
  vault: string;
  service: ProjectBootstrapService;
  registry: VaultRegistry;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-bootstrap-'));
  roots.push(root);
  const project = path.join(root, 'project');
  const vault = path.join(root, 'vault');
  await mkdir(project);
  await mkdir(vault);
  await writeFile(path.join(vault, '00 - Project Home.md'), '# Home\n');
  const registry = await VaultRegistry.load(path.join(root, 'config.json'), {
    vaultRoot: root,
  });
  await registry.register('personal', vault);
  const files = new FilesystemService(registry);
  const mapping = new ProjectMappingService(registry, files);
  return {
    root,
    project,
    vault,
    service: new ProjectBootstrapService(registry, mapping, files),
    registry,
  };
}

describe('project bootstrap service', () => {
  it('creates portable project configuration and reports detected notes', async () => {
    const { project, service } = await makeService();

    const result = await service.initialize(project, 'personal');
    const localDirectory = path.join(project, '.obsidian-local');

    expect(result.files.map((file) => file.path)).toEqual([
      'config.json',
      'mapping.yaml',
      'README.md',
    ]);
    expect(await readdir(localDirectory)).toEqual(
      expect.arrayContaining(['config.json', 'mapping.yaml', 'README.md']),
    );
    expect(
      await readFile(path.join(localDirectory, 'config.json'), 'utf8'),
    ).toContain('"vault": "personal"');
    expect(result.detected).toContain('00 - Project Home.md');
  });

  it('syncs edited mappings without creating or moving vault notes', async () => {
    const { project, vault, service, registry } = await makeService();
    await service.initialize(project, 'personal');
    const originalFiles = await readdir(vault);
    await writeFile(
      path.join(project, '.obsidian-local', 'mapping.yaml'),
      'schemaVersion: 1\nvault: personal\ntree:\n  - id: planning\n    title: Planning\n    type: group\n    children:\n      - id: task_list\n        title: Tasks\n        type: note\n        path: Planning/Tasks.md\n        alias: tasks\n',
    );

    const result = await service.sync(project);

    expect(result.added).toContain('planning.task_list');
    expect(registry.get('personal').codebaseIndex).toMatchObject({
      roles: { 'planning.task_list': 'Planning/Tasks.md' },
      aliases: { tasks: 'planning.task_list' },
    });
    expect(await readdir(vault)).toEqual(originalFiles);
    await expect(
      readFile(path.join(vault, 'Planning', 'Tasks.md')),
    ).rejects.toThrow();
  });

  it('replaces generated files but preserves unrelated local files', async () => {
    const { project, service } = await makeService();
    await service.initialize(project, 'personal');
    await writeFile(
      path.join(project, '.obsidian-local', 'custom-notes.txt'),
      'keep me\n',
    );
    await writeFile(
      path.join(project, '.obsidian-local', 'README.md'),
      'old generated content\n',
    );

    const result = await service.initialize(project, 'personal', true);

    expect(result.files.find((file) => file.path === 'README.md')?.action).toBe(
      'replaced',
    );
    await expect(
      readFile(
        path.join(project, '.obsidian-local', 'custom-notes.txt'),
        'utf8',
      ),
    ).resolves.toBe('keep me\n');
  });
});
