import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import matter from 'gray-matter';
import { stringify } from 'yaml';

const VOLATILE_FRONTMATTER = new Set(['generated_at', 'projection_hash']);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalHash(value: unknown): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) {
    throw new TypeError('Canonical knowledge values must be JSON serializable');
  }
  return sha256(serialized);
}

export function normalizeManagedMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/gu, '\n');
  const parsed = matter(normalized);
  const stableEntries = Object.entries(parsed.data)
    .filter(([key]) => !VOLATILE_FRONTMATTER.has(key))
    .sort(([left], [right]) => left.localeCompare(right));
  const stableData = Object.fromEntries(stableEntries);
  const body = parsed.content.trimEnd();
  if (stableEntries.length === 0) return `${body}\n`;
  const frontmatter = stringify(stableData, {
    lineWidth: 0,
    sortMapEntries: true,
  }).trimEnd();
  return `---\n${frontmatter}\n---\n${body}\n`;
}

export function projectionHash(markdown: string): string {
  return sha256(normalizeManagedMarkdown(markdown));
}

export function sourceHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
