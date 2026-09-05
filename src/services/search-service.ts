import matter from 'gray-matter';
import type { VaultRegistry } from '../config/registry.js';
import { FilesystemService } from './filesystem-service.js';

export interface SearchMatch {
  path: string;
  excerpt: string;
  matches: string[];
}

function excerpt(content: string, terms: string[]): string {
  const normalized = content.replace(/\s+/gu, ' ').trim();
  const lowered = normalized.toLowerCase();
  const firstMatch = terms
    .map((term) => ({
      term,
      index: lowered.indexOf(term),
    }))
    .filter((match) => match.index >= 0)
    .sort((a, b) => a.index - b.index)[0];
  const index = firstMatch?.index ?? -1;
  if (index < 0) return normalized.slice(0, 180);
  return normalized.slice(
    Math.max(0, index - 70),
    index + (firstMatch?.term.length ?? 0) + 110,
  );
}

function includesAnyTerm(value: string, terms: string[]): boolean {
  const lowered = value.toLowerCase();
  return terms.some((term) => lowered.includes(term));
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
    const terms = normalizedQuery.split(/\s+/u).filter(Boolean);
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
      if (!terms.every((term) => haystack.includes(term))) continue;
      const matchTypes: string[] = [];
      if (includesAnyTerm(note.path, terms)) matchTypes.push('filename');
      if (includesAnyTerm(noteContent.content, terms))
        matchTypes.push('content');
      if (includesAnyTerm(frontmatterText, terms))
        matchTypes.push('frontmatter');
      matches.push({
        path: note.path,
        excerpt: excerpt(noteContent.content, terms),
        matches: matchTypes,
      });
      if (matches.length >= boundedLimit) break;
    }
    return matches;
  }
}
