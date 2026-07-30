import matter from 'gray-matter';
import type { VaultRegistry } from '../config/registry.js';
import { FilesystemService } from './filesystem-service.js';

export interface SearchMatch {
  path: string;
  excerpt: string;
  matches: string[];
}

function excerpt(content: string, query: string): string {
  const normalized = content.replace(/\s+/gu, ' ').trim();
  const index = normalized.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return normalized.slice(0, 180);
  return normalized.slice(Math.max(0, index - 70), index + query.length + 110);
}

export class SearchService {
  private readonly files: FilesystemService;

  constructor(
    private readonly registry: VaultRegistry,
    files?: FilesystemService,
  ) {
    this.files = files ?? new FilesystemService(registry);
  }

  async search(
    vaultName: string,
    query: string,
    limit = 20,
    relativeDirectory = '',
  ): Promise<SearchMatch[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const matches: SearchMatch[] = [];
    for (const note of await this.files.listNotes(
      vaultName,
      relativeDirectory,
    )) {
      const noteContent = await this.files.readNote(vaultName, note.path);
      const parsed = matter(noteContent.content);
      const frontmatterText = JSON.stringify(parsed.data);
      const haystack =
        `${note.path}\n${noteContent.content}\n${frontmatterText}`.toLowerCase();
      if (!haystack.includes(normalizedQuery)) continue;
      const matchTypes: string[] = [];
      if (note.path.toLowerCase().includes(normalizedQuery))
        matchTypes.push('filename');
      if (noteContent.content.toLowerCase().includes(normalizedQuery))
        matchTypes.push('content');
      if (frontmatterText.toLowerCase().includes(normalizedQuery))
        matchTypes.push('frontmatter');
      matches.push({
        path: note.path,
        excerpt: excerpt(noteContent.content, normalizedQuery),
        matches: matchTypes,
      });
      if (matches.length >= boundedLimit) break;
    }
    return matches;
  }
}
