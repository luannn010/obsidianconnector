import type { VaultRegistry } from '../config/registry.js';
import type { AffectedFile } from '../types/index.js';
import { SecurityError } from '../security/path-security.js';
import { FilesystemService } from './filesystem-service.js';

function formatDate(date: Date, format: string): string {
  const values: Record<string, string> = {
    YYYY: String(date.getFullYear()).padStart(4, '0'),
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    DD: String(date.getDate()).padStart(2, '0'),
  };
  return format.replace(/YYYY|MM|DD/gu, (token) => values[token] ?? token);
}

export class DailyNoteService {
  constructor(
    private readonly registry: VaultRegistry,
    private readonly files: FilesystemService,
  ) {}

  async append(
    vaultName: string,
    content: string,
    date = new Date(),
  ): Promise<AffectedFile> {
    const config = this.registry.get(vaultName).dailyNotes;
    const relativePath = `${config.directory.replace(/[\\/]+$/u, '')}/${formatDate(date, config.dateFormat)}.md`;
    try {
      return await this.files.appendNote(vaultName, relativePath, content);
    } catch (error) {
      if (error instanceof SecurityError && error.code === 'NOT_FOUND')
        return this.files.createNote(vaultName, relativePath, content);
      if (error instanceof Error && error.message.includes('ENOENT'))
        return this.files.createNote(vaultName, relativePath, content);
      throw error;
    }
  }
}
