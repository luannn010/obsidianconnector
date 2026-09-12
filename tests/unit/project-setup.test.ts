import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMissingStarterNotes,
  ensureGitHead,
  resolvePortableSetupPaths,
} from '../../src/setup/project-setup-service.js';
import { VaultRegistry } from '../../src/config/registry.js';
import { FilesystemService } from '../../src/services/filesystem-service.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('project setup', () => {
  it('derives portable project and vault paths beneath their configured roots', () => {
    expect(
      resolvePortableSetupPaths({
        projectPath: 'D:\\Host-Mesh',
        projectsRoot: 'D:\\',
        vaultPath: 'G:\\My Drive\\.obsidian\\Host-Mesh',
        vaultRoot: 'G:\\My Drive\\.obsidian',
      }),
    ).toMatchObject({
      projectRelativePath: 'Host-Mesh',
      vaultRelativePath: 'Host-Mesh',
    });
  });

  it('rejects a vault outside the configured vault root', () => {
    expect(() =>
      resolvePortableSetupPaths({
        projectPath: 'D:\\Host-Mesh',
        projectsRoot: 'D:\\',
        vaultPath: 'C:\\Private\\Host-Mesh',
        vaultRoot: 'G:\\My Drive\\.obsidian',
      }),
    ).toThrow('vault root');
  });

  it('creates an empty Git bootstrap commit without staging existing files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'project-setup-git-'));
    roots.push(root);
    await writeFile(path.join(root, 'AGENTS.md'), '# Existing\n');

    const result = await ensureGitHead(root);
    const tracked = await execFileAsync('git', ['-C', root, 'ls-files'], {
      encoding: 'utf8',
    });
    const status = await execFileAsync(
      'git',
      ['-C', root, 'status', '--porcelain'],
      { encoding: 'utf8' },
    );

    expect(result.createdRepository).toBe(true);
    expect(result.createdCommit).toBe(true);
    expect(result.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(tracked.stdout.trim()).toBe('');
    expect(status.stdout).toContain('?? AGENTS.md');

    await expect(ensureGitHead(root)).resolves.toMatchObject({
      createdRepository: false,
      createdCommit: false,
      head: result.head,
    });
  });

  it('creates missing starter notes and preserves existing notes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'project-setup-vault-'));
    roots.push(root);
    const vault = path.join(root, 'Host-Mesh');
    await writeFile(path.join(root, 'placeholder'), '');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(vault));
    await writeFile(
      path.join(vault, '00 - Project Home.md'),
      '# Custom home\n',
    );
    const registry = await VaultRegistry.load(path.join(root, 'vaults.json'), {
      vaultRoot: root,
    });
    await registry.register('Host-Mesh', vault);

    const result = await createMissingStarterNotes(
      new FilesystemService(registry),
      'Host-Mesh',
      'Host-Mesh',
    );

    expect(result.created).toContain('11 - Changelog.md');
    expect(result.preserved).toContain('00 - Project Home.md');
    expect(
      await readFile(path.join(vault, '00 - Project Home.md'), 'utf8'),
    ).toBe('# Custom home\n');
    expect(await readdir(vault)).toHaveLength(12);
  });
});
