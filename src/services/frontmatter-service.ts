import matter from 'gray-matter';
import type { AffectedFile } from '../types/index.js';
import { FilesystemService } from './filesystem-service.js';

export type Frontmatter = Record<string, unknown>;

export class FrontmatterService {
  constructor(private readonly files: FilesystemService) {}

  async get(vaultName: string, relativePath: string): Promise<Frontmatter> {
    const note = await this.files.readNote(vaultName, relativePath);
    return matter(note.content).data as Frontmatter;
  }

  async update(
    vaultName: string,
    relativePath: string,
    properties: Frontmatter,
  ): Promise<AffectedFile> {
    const note = await this.files.readNote(vaultName, relativePath);
    const parsed = matter(note.content);
    const merged = { ...(parsed.data as Frontmatter), ...properties };
    const updatedContent = matter.stringify(parsed.content, merged);
    return this.files.updateNote(
      vaultName,
      relativePath,
      updatedContent,
      note.contentHash,
    );
  }
}
