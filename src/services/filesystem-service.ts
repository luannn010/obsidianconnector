import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { AffectedFile } from '../types/index.js';
import type { RegisteredVault, VaultRegistry } from '../config/registry.js';
import { resolveVaultPath } from '../security/path-security.js';

export interface NoteEntry {
  path: string;
  contentHash: string;
}

export interface DirectoryEntry {
  path: string;
  type: 'file' | 'directory';
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function toRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

function isHiddenDirectory(name: string): boolean {
  return (
    name.startsWith('.') ||
    name === '.obsidian' ||
    name === '.trash' ||
    name === 'node_modules'
  );
}

export class FilesystemService {
  constructor(private readonly registry: VaultRegistry) {}

  private vault(name: string): RegisteredVault {
    return this.registry.get(name);
  }

  private assertWritable(vault: RegisteredVault): void {
    if (vault.readOnly) throw new Error(`Vault is read-only: ${vault.name}`);
  }

  private async notePath(
    vault: RegisteredVault,
    relativePath: string,
    allowMissing = false,
  ): Promise<string> {
    return resolveVaultPath(vault.path, relativePath, {
      kind: 'note',
      allowMissing,
    });
  }

  private async directoryPath(
    vault: RegisteredVault,
    relativePath: string,
    allowMissing = false,
  ): Promise<string> {
    if (!relativePath) return vault.path;
    return resolveVaultPath(vault.path, relativePath, {
      kind: 'directory',
      allowMissing,
    });
  }

  async listDirectory(
    vaultName: string,
    relativeDirectory = '',
  ): Promise<DirectoryEntry[]> {
    const vault = this.vault(vaultName);
    const directory = await this.directoryPath(vault, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          !entry.isSymbolicLink() &&
          !(entry.isDirectory() && isHiddenDirectory(entry.name)),
      )
      .filter(
        (entry) =>
          entry.isDirectory() || entry.name.toLowerCase().endsWith('.md'),
      )
      .map((entry) => ({
        path: toRelative(vault.path, path.join(directory, entry.name)),
        type: entry.isDirectory() ? 'directory' : 'file',
      }));
  }

  async createDirectory(
    vaultName: string,
    relativeDirectory: string,
  ): Promise<{ vault: string; path: string }> {
    const vault = this.vault(vaultName);
    this.assertWritable(vault);
    const directory = await this.directoryPath(vault, relativeDirectory, true);
    await mkdir(directory, { recursive: true });
    return { vault: vault.name, path: toRelative(vault.path, directory) };
  }

  async listNotes(
    vaultName: string,
    relativeDirectory = '',
  ): Promise<NoteEntry[]> {
    const vault = this.vault(vaultName);
    const start = await this.directoryPath(vault, relativeDirectory);
    const notes: NoteEntry[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isSymbolicLink() ||
          (entry.isDirectory() && isHiddenDirectory(entry.name))
        )
          continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolute);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          const content = await readFile(absolute, 'utf8');
          notes.push({
            path: toRelative(vault.path, absolute),
            contentHash: hashContent(content),
          });
        }
      }
    };
    await visit(start);
    return notes.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readNote(
    vaultName: string,
    relativePath: string,
  ): Promise<{
    vault: string;
    path: string;
    content: string;
    contentHash: string;
  }> {
    const vault = this.vault(vaultName);
    const absolute = await this.notePath(vault, relativePath);
    const content = await readFile(absolute, 'utf8');
    return {
      vault: vault.name,
      path: toRelative(vault.path, absolute),
      content,
      contentHash: hashContent(content),
    };
  }

  async createNote(
    vaultName: string,
    relativePath: string,
    content: string,
    overwrite = false,
  ): Promise<AffectedFile> {
    const vault = this.vault(vaultName);
    this.assertWritable(vault);
    const absolute = await this.notePath(vault, relativePath, true);
    if (!overwrite && (await stat(absolute).catch(() => undefined)))
      throw new Error(`Note already exists: ${relativePath}`);
    await this.atomicWrite(absolute, content);
    return {
      vault: vault.name,
      path: toRelative(vault.path, absolute),
      contentHash: hashContent(content),
    };
  }

  async updateNote(
    vaultName: string,
    relativePath: string,
    content: string,
    expectedHash?: string,
  ): Promise<AffectedFile> {
    const vault = this.vault(vaultName);
    this.assertWritable(vault);
    const absolute = await this.notePath(vault, relativePath);
    const current = await readFile(absolute, 'utf8');
    if (expectedHash && hashContent(current) !== expectedHash)
      throw new Error('Note content hash does not match expected hash');
    await this.atomicWrite(absolute, content);
    return {
      vault: vault.name,
      path: toRelative(vault.path, absolute),
      contentHash: hashContent(content),
    };
  }

  async appendNote(
    vaultName: string,
    relativePath: string,
    content: string,
  ): Promise<AffectedFile> {
    const vault = this.vault(vaultName);
    this.assertWritable(vault);
    const absolute = await this.notePath(vault, relativePath);
    const next = `${await readFile(absolute, 'utf8')}${content}`;
    await this.atomicWrite(absolute, next);
    return {
      vault: vault.name,
      path: toRelative(vault.path, absolute),
      contentHash: hashContent(next),
    };
  }

  async moveNote(
    vaultName: string,
    sourcePath: string,
    destinationPath: string,
    overwrite = false,
  ): Promise<AffectedFile> {
    const vault = this.vault(vaultName);
    this.assertWritable(vault);
    const source = await this.notePath(vault, sourcePath);
    const destination = await this.notePath(vault, destinationPath, true);
    if (!overwrite && (await stat(destination).catch(() => undefined)))
      throw new Error(`Destination already exists: ${destinationPath}`);
    await mkdir(path.dirname(destination), { recursive: true });
    const content = await readFile(source, 'utf8');
    await rename(source, destination);
    return {
      vault: vault.name,
      path: toRelative(vault.path, destination),
      contentHash: hashContent(content),
    };
  }

  async deleteNote(
    vaultName: string,
    relativePath: string,
  ): Promise<{ vault: string; path: string }> {
    const vault = this.vault(vaultName);
    this.assertWritable(vault);
    const source = await this.notePath(vault, relativePath);
    const trashRoot = path.join(vault.path, '.trash');
    await mkdir(trashRoot, { recursive: true });
    const base = path.basename(relativePath);
    let destination = path.join(trashRoot, base);
    while (await stat(destination).catch(() => undefined))
      destination = path.join(
        trashRoot,
        `${path.parse(base).name}-${randomUUID()}${path.extname(base)}`,
      );
    await rename(source, destination);
    return { vault: vault.name, path: toRelative(vault.path, destination) };
  }

  async listTrash(vaultName: string): Promise<NoteEntry[]> {
    const vault = this.vault(vaultName);
    const trashRoot = path.join(vault.path, '.trash');
    const entries = await readdir(trashRoot, { withFileTypes: true }).catch(
      () => [],
    );
    const notes: NoteEntry[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const absolute = path.join(trashRoot, entry.name);
        const content = await readFile(absolute, 'utf8');
        notes.push({
          path: toRelative(vault.path, absolute),
          contentHash: hashContent(content),
        });
      }
    }
    return notes;
  }

  private async atomicWrite(absolute: string, content: string): Promise<void> {
    await mkdir(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, 'utf8');
    try {
      await rename(temporary, absolute);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' &&
        (error as NodeJS.ErrnoException).code !== 'EPERM'
      )
        throw error;
      await rm(absolute, { force: true });
      await rename(temporary, absolute);
    }
  }
}
