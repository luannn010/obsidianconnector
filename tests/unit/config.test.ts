import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getConfigPath, VaultRegistry } from '../../src/config/registry.js';

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

    const registry = await VaultRegistry.load(configPath);
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

    await registry.register('notes', vault, true);
    expect(registry.get('notes').readOnly).toBe(true);
    expect(
      JSON.parse(await readFile(configPath, 'utf8')).vaults.notes.path,
    ).toBe(path.resolve(vault));

    await registry.unregister('notes');
    expect(registry.list()).toEqual([]);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      vaults: {},
    });
  });

  it('creates and registers a vault directory', async () => {
    const directory = await makeTempDirectory();
    const configPath = path.join(directory, 'vaults.json');
    const registry = await VaultRegistry.load(configPath);
    const vault = path.join(directory, 'created');

    await registry.create('created', vault);

    expect(registry.get('created').path).toBe(path.resolve(vault));
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
