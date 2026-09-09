import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { sourceHash } from '../knowledge/hash.js';

export interface LegacyNoteInventory {
  originalPath: string;
  rawHash: string;
  sizeBytes: number;
  modifiedAt: Date;
  frontmatter: Record<string, unknown>;
  outboundLinks: string[];
  bodyMarkdown?: string;
  contentOmittedReason?: 'sensitive-path';
}

const SENSITIVE_PATH =
  /(?:^|[/\\])(?:\.env|credentials?|secrets?)(?:[ ._/\\-]|$)/iu;

async function markdownFiles(
  root: string,
  directory = root,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (['.obsidian', '.git', 'Published'].includes(entry.name)) return [];
        return markdownFiles(root, absolute);
      }
      return entry.isFile() && entry.name.toLowerCase().endsWith('.md')
        ? [absolute]
        : [];
    }),
  );
  return nested.flat();
}

export async function inventoryLegacyNotes(
  vaultRoot: string,
): Promise<LegacyNoteInventory[]> {
  const files = (await markdownFiles(vaultRoot)).sort();
  return Promise.all(
    files.map(async (absolute) => {
      const [buffer, info] = await Promise.all([
        readFile(absolute),
        stat(absolute),
      ]);
      const raw = buffer.toString('utf8');
      const parsed = matter(raw);
      const originalPath = path
        .relative(vaultRoot, absolute)
        .split(path.sep)
        .join('/');
      const outboundLinks = [
        ...raw.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/gu),
      ]
        .map((match) => match[1]?.trim())
        .filter((value): value is string => Boolean(value));
      const common = {
        originalPath,
        rawHash: sourceHash(buffer),
        sizeBytes: info.size,
        modifiedAt: info.mtime,
        frontmatter: parsed.data as Record<string, unknown>,
        outboundLinks: [...new Set(outboundLinks)],
      };
      return SENSITIVE_PATH.test(originalPath)
        ? {
            ...common,
            bodyMarkdown: undefined,
            contentOmittedReason: 'sensitive-path' as const,
          }
        : { ...common, bodyMarkdown: raw };
    }),
  );
}
