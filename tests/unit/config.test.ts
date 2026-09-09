import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getConfigPath,
  loadDotEnv,
  loadProjectKnowledgeEnvironment,
  VaultRegistry,
} from '../../src/config/registry.js';

const temporaryDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'obsidian-mcp-config-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  delete process.env.OBSIDIAN_MCP_CONFIG;
  delete process.env.OBSIDIAN_VAULT_ROOT;
  delete process.env.PROJECT_KNOWLEDGE_DATABASE_URL;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('configuration and vault registry', () => {
  it('uses the environment override and defaults to config/vaults.json', () => {
    expect(getConfigPath({ cwd: 'C:\\project' })).toBe(
      path.resolve('C:\\project', 'config', 'vaults.json'),
    );
    process.env.OBSIDIAN_MCP_CONFIG = 'config/vaults.json';
    expect(getConfigPath({ cwd: 'C:\\connector' })).toBe(
      path.resolve('C:\\connector', 'config', 'vaults.json'),
    );
    process.env.OBSIDIAN_MCP_CONFIG = 'C:\\custom\\vaults.json';
    expect(getConfigPath({ cwd: 'C:\\project' })).toBe(
      path.resolve('C:\\custom\\vaults.json'),
    );
  });

  it('loads multiple vaults with safe defaults', async () => {
    const directory = await makeTempDirectory();
    const personal = path.join(directory, 'personal');
    const work = path.join(directory, 'work');
    await mkdir(personal);
    await mkdir(work);
    const configPath = path.join(directory, 'vaults.json');
    await writeFile(
      configPath,
      JSON.stringify({
        vaults: {
          personal: { path: personal },
          work: { path: work, readOnly: true },
        },
      }),
    );

    const registry = await VaultRegistry.load(configPath, {
      vaultRoot: directory,
    });
    expect(registry.list()).toEqual([
      expect.objectContaining({
        name: 'personal',
        path: path.resolve(personal),
        readOnly: false,
      }),
      expect.objectContaining({
        name: 'work',
        path: path.resolve(work),
        readOnly: true,
      }),
    ]);
    expect(registry.get('personal').dailyNotes).toEqual({
      directory: 'Daily',
      dateFormat: 'YYYY-MM-DD',
    });
  });

  it('registers and unregisters vaults through an atomic config file', async () => {
    const directory = await makeTempDirectory();
    const vault = path.join(directory, 'new-vault');
    await mkdir(vault);
    const configPath = path.join(directory, 'vaults.json');
    const registry = await VaultRegistry.load(configPath);

    await registry.register('notes', vault, true, undefined, {
      roles: { tasks: 'Plans/Tasks.md' },
    });
    expect(registry.get('notes').readOnly).toBe(true);
    expect(registry.get('notes').codebaseIndex.roles).toEqual({
      tasks: 'Plans/Tasks.md',
    });
    expect(
      JSON.parse(await readFile(configPath, 'utf8')).vaults.notes.path,
    ).toBe(path.resolve(vault));
    expect(
      JSON.parse(await readFile(configPath, 'utf8')).vaults.notes.codebaseIndex
        .roles,
    ).toEqual({ tasks: 'Plans/Tasks.md' });

    await registry.unregister('notes');
    expect(registry.list()).toEqual([]);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      vaults: {},
    });
  });

  it('creates and registers a vault directory', async () => {
    const directory = await makeTempDirectory();
    const configPath = path.join(directory, 'vaults.json');
    const registry = await VaultRegistry.load(configPath, {
      vaultRoot: directory,
    });
    const vault = path.join(directory, 'created');

    await registry.create('created');

    expect(registry.get('created').path).toBe(path.resolve(vault));
  });

  it('updates project roles and aliases without changing vault registration', async () => {
    const directory = await makeTempDirectory();
    const vault = path.join(directory, 'mapped');
    await mkdir(vault);
    const registry = await VaultRegistry.load(
      path.join(directory, 'vaults.json'),
    );
    await registry.register('mapped', vault, true);

    await registry.updateCodebaseIndex('mapped', {
      roles: { 'planning.task_list': 'Planning/Tasks.md' },
      aliases: { tasks: 'planning.task_list' },
    });

    expect(registry.get('mapped')).toMatchObject({
      path: path.resolve(vault),
      readOnly: true,
      codebaseIndex: {
        roles: { 'planning.task_list': 'Planning/Tasks.md' },
        aliases: { tasks: 'planning.task_list' },
      },
    });
    expect(
      JSON.parse(await readFile(path.join(directory, 'vaults.json'), 'utf8'))
        .vaults.mapped.codebaseIndex.aliases,
    ).toEqual({ tasks: 'planning.task_list' });
  });

  it('lists only registered vaults beneath the configured vault root', async () => {
    const directory = await makeTempDirectory();
    const root = path.join(directory, 'obsidian');
    const outside = path.join(directory, 'outside');
    await mkdir(root);
    await mkdir(path.join(root, 'inside'));
    await mkdir(outside);
    const registry = await VaultRegistry.load(
      path.join(directory, 'vaults.json'),
      { vaultRoot: root },
    );

    await registry.register('inside', path.join(root, 'inside'));
    await registry.register('outside', outside);
    expect(registry.list().map((vault) => vault.name)).toEqual(['inside']);
  });

  it('does not inspect configured vaults outside the focused vault root', async () => {
    const directory = await makeTempDirectory();
    const root = path.join(directory, 'obsidian');
    const inside = path.join(root, 'inside');
    const missingOutside = path.join(directory, 'missing-outside');
    await mkdir(inside, { recursive: true });
    const configPath = path.join(directory, 'vaults.json');
    await writeFile(
      configPath,
      JSON.stringify({
        vaults: {
          inside: { path: inside },
          external: { path: missingOutside },
        },
      }),
    );

    const registry = await VaultRegistry.load(configPath, { vaultRoot: root });

    expect(registry.list().map((vault) => vault.name)).toEqual(['inside']);
  });

  it('loads vault root from a dotenv file without overriding existing variables', async () => {
    const directory = await makeTempDirectory();
    const envPath = path.join(directory, '.env');
    await writeFile(envPath, 'OBSIDIAN_VAULT_ROOT="G:\\My Drive\\.obsidian"\n');

    loadDotEnv(envPath);

    expect(process.env.OBSIDIAN_VAULT_ROOT).toBe('G:\\My Drive\\.obsidian');
  });

  it('loads protected home defaults before repository dotenv values', async () => {
    const directory = await makeTempDirectory();
    const home = path.join(directory, 'home');
    const project = path.join(directory, 'project');
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(home, '.codex', 'project-knowledge.env'),
      'PROJECT_KNOWLEDGE_DATABASE_URL=postgresql://home/default\n',
    );
    await writeFile(
      path.join(project, '.env'),
      'PROJECT_KNOWLEDGE_DATABASE_URL=postgresql://repository/fallback\n',
    );

    loadProjectKnowledgeEnvironment(project, home);

    expect(process.env.PROJECT_KNOWLEDGE_DATABASE_URL).toBe(
      'postgresql://home/default',
    );
  });

  it('rejects invalid names and duplicate registrations', async () => {
    const directory = await makeTempDirectory();
    const vault = path.join(directory, 'vault');
    await mkdir(vault);
    const registry = await VaultRegistry.load(
      path.join(directory, 'vaults.json'),
    );

    await expect(registry.register('', vault)).rejects.toThrow('Vault name');
    await registry.register('same', vault);
    await expect(registry.register('same', vault)).rejects.toThrow(
      'already registered',
    );
  });
});
