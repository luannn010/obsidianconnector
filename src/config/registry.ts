import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  VaultsFileSchema,
  type DailyNotesConfig,
  type VaultConfig,
} from './schema.js';

export interface RegisteredVault extends VaultConfig {
  name: string;
}

export interface ConfigPathOptions {
  cwd?: string;
}

export function getConfigPath(options: ConfigPathOptions = {}): string {
  const configured = process.env.OBSIDIAN_MCP_CONFIG;
  if (configured?.trim()) {
    return path.resolve(configured);
  }
  return path.resolve(options.cwd ?? process.cwd(), 'config', 'vaults.json');
}

function validateName(name: string): string {
  const normalized = name.trim();
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.includes('/') ||
    normalized.includes('\\')
  ) {
    throw new Error('Vault name must be a non-empty path-free value');
  }
  return normalized;
}

async function canonicalDirectory(
  directory: string,
  requireExisting = true,
): Promise<string> {
  const resolved = path.resolve(directory);
  if (!requireExisting) {
    return resolved;
  }
  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error('Vault directory does not exist');
  }
  return realpath(resolved);
}

export class VaultRegistry {
  private constructor(
    private readonly configPath: string,
    private readonly vaults: Map<string, RegisteredVault>,
  ) {}

  static async load(configPath = getConfigPath()): Promise<VaultRegistry> {
    const resolvedConfigPath = path.resolve(configPath);
    let parsed: ReturnType<typeof VaultsFileSchema.parse>;
    try {
      parsed = VaultsFileSchema.parse(
        JSON.parse(await readFile(resolvedConfigPath, 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof SyntaxError) {
          throw new Error('Vault configuration is not valid JSON');
        }
        throw error;
      }
      parsed = { vaults: {} };
    }

    const entries = new Map<string, RegisteredVault>();
    for (const [name, config] of Object.entries(parsed.vaults)) {
      const normalizedName = validateName(name);
      entries.set(normalizedName, {
        name: normalizedName,
        ...config,
        path: await canonicalDirectory(config.path),
      });
    }
    return new VaultRegistry(resolvedConfigPath, entries);
  }

  list(): RegisteredVault[] {
    return [...this.vaults.values()].map((vault) => ({
      ...vault,
      dailyNotes: { ...vault.dailyNotes },
    }));
  }

  get(name: string): RegisteredVault {
    const vault = this.vaults.get(name);
    if (!vault) {
      throw new Error(`Vault is not registered: ${name}`);
    }
    return { ...vault, dailyNotes: { ...vault.dailyNotes } };
  }

  async register(
    name: string,
    directory: string,
    readOnly = false,
    dailyNotes?: Partial<DailyNotesConfig>,
  ): Promise<RegisteredVault> {
    const normalizedName = validateName(name);
    if (this.vaults.has(normalizedName)) {
      throw new Error(`Vault is already registered: ${normalizedName}`);
    }
    const vault: RegisteredVault = {
      name: normalizedName,
      path: await canonicalDirectory(directory),
      readOnly,
      dailyNotes: {
        directory: dailyNotes?.directory?.trim() || 'Daily',
        dateFormat: dailyNotes?.dateFormat?.trim() || 'YYYY-MM-DD',
      },
    };
    this.vaults.set(normalizedName, vault);
    await this.persist();
    return this.get(normalizedName);
  }

  async create(
    name: string,
    directory: string,
    readOnly = false,
    dailyNotes?: Partial<DailyNotesConfig>,
  ): Promise<RegisteredVault> {
    await mkdir(path.resolve(directory), { recursive: true });
    return this.register(name, directory, readOnly, dailyNotes);
  }

  async unregister(name: string): Promise<void> {
    if (!this.vaults.delete(name)) {
      throw new Error(`Vault is not registered: ${name}`);
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.configPath), { recursive: true });
    const data = JSON.stringify(
      {
        vaults: Object.fromEntries(
          [...this.vaults.entries()].map(([name, vault]) => [
            name,
            {
              path: vault.path,
              readOnly: vault.readOnly,
              dailyNotes: vault.dailyNotes,
            },
          ]),
        ),
      },
      null,
      2,
    );
    const temporaryPath = `${this.configPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${data}\n`, 'utf8');
    await rename(temporaryPath, this.configPath);
  }
}
