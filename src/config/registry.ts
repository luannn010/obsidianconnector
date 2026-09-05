import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  VaultsFileSchema,
  type DailyNotesConfig,
  type CodebaseIndexConfig,
  type VaultConfig,
} from './schema.js';

export interface RegisteredVault extends VaultConfig {
  name: string;
}

export interface ConfigPathOptions {
  cwd?: string;
}

export interface VaultRegistryOptions {
  vaultRoot?: string;
}

export const DEFAULT_VAULT_ROOT = 'G:\\My Drive\\.obsidian';

export function loadDotEnv(
  envPath = path.resolve(process.cwd(), '.env'),
): void {
  let content: string;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match?.[1] || process.env[match[1]] !== undefined) continue;
    const value = match[2] ?? '';
    process.env[match[1]] =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
        ? value.slice(1, -1)
        : value;
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== '..')
  );
}

export function getConfigPath(options: ConfigPathOptions = {}): string {
  const configured = process.env.OBSIDIAN_MCP_CONFIG;
  if (configured?.trim()) {
    return path.resolve(options.cwd ?? process.cwd(), configured);
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
    private readonly vaultRoot: string,
  ) {}

  static async load(
    configPath = getConfigPath(),
    options: VaultRegistryOptions = {},
  ): Promise<VaultRegistry> {
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

    const vaultRoot = path.resolve(
      options.vaultRoot ??
        process.env.OBSIDIAN_VAULT_ROOT ??
        DEFAULT_VAULT_ROOT,
    );
    const entries = new Map<string, RegisteredVault>();
    for (const [name, config] of Object.entries(parsed.vaults)) {
      const normalizedName = validateName(name);
      const configuredPath = path.resolve(config.path);
      if (!isWithinRoot(vaultRoot, configuredPath)) {
        continue;
      }
      const canonicalPath = await canonicalDirectory(configuredPath);
      if (!isWithinRoot(vaultRoot, canonicalPath)) {
        continue;
      }
      entries.set(normalizedName, {
        name: normalizedName,
        ...config,
        path: canonicalPath,
      });
    }
    return new VaultRegistry(resolvedConfigPath, entries, vaultRoot);
  }

  list(): RegisteredVault[] {
    return [...this.vaults.values()]
      .filter((vault) => isWithinRoot(this.vaultRoot, vault.path))
      .map((vault) => ({
        ...vault,
        dailyNotes: { ...vault.dailyNotes },
        codebaseIndex: { ...vault.codebaseIndex },
      }));
  }

  get(name: string): RegisteredVault {
    const vault = this.vaults.get(name);
    if (!vault) {
      throw new Error(`Vault is not registered: ${name}`);
    }
    return {
      ...vault,
      dailyNotes: { ...vault.dailyNotes },
      codebaseIndex: { ...vault.codebaseIndex },
    };
  }

  async register(
    name: string,
    directory: string,
    readOnly = false,
    dailyNotes?: Partial<DailyNotesConfig>,
    codebaseIndex?: Partial<CodebaseIndexConfig>,
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
      codebaseIndex: {
        manifest: codebaseIndex?.manifest?.trim() || 'Codebase Index.md',
        maxAgeDays: codebaseIndex?.maxAgeDays ?? 30,
        roles: { ...(codebaseIndex?.roles ?? {}) },
      },
    };
    this.vaults.set(normalizedName, vault);
    await this.persist();
    return this.get(normalizedName);
  }

  async create(
    name: string,
    readOnly = false,
    dailyNotes?: Partial<DailyNotesConfig>,
    codebaseIndex?: Partial<CodebaseIndexConfig>,
  ): Promise<RegisteredVault> {
    const normalizedName = validateName(name);
    const directory = path.join(this.vaultRoot, normalizedName);
    await mkdir(directory, { recursive: true });
    return this.register(
      normalizedName,
      directory,
      readOnly,
      dailyNotes,
      codebaseIndex,
    );
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
              codebaseIndex: vault.codebaseIndex,
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
