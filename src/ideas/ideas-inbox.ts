import { createHash } from 'node:crypto';

export const IDEAS_NOTE = 'Ideas.md';

export interface IdeaEntry {
  ref: string;
  text: string;
  line: number;
}

export interface TriagedLink {
  slug: string;
  title: string;
}

const bulletPattern = /^[-*] (?:\[[ xX]\] )?(.*)$/u;
const triagedPattern = /→ \[\[[^\]]+\]\]/u;
const blockIdPattern = /\s+\^(idea-[a-z0-9]+)\s*$/u;

function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return 0;
  const close = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  );
  return close === -1 ? 0 : close + 1;
}

function ideaRef(head: string, text: string): string {
  const existing = blockIdPattern.exec(head)?.[1];
  if (existing) return existing;
  const normalized = text.toLowerCase().replace(/\s+/gu, ' ').trim();
  return `idea-${createHash('sha256').update(normalized).digest('hex').slice(0, 8)}`;
}

interface RawIdea {
  index: number;
  head: string;
  body: string[];
}

function collectIdeas(lines: string[]): RawIdea[] {
  const ideas: RawIdea[] = [];
  let current: RawIdea | undefined;
  for (let index = frontmatterEnd(lines); index < lines.length; index += 1) {
    const line = lines[index]!;
    const bullet = bulletPattern.exec(line);
    if (bullet) {
      current = { index, head: bullet[1]!, body: [] };
      ideas.push(current);
    } else if (current && /^\s+\S/u.test(line)) {
      current.body.push(line.trim().replace(/^[-*] /u, ''));
    } else if (line.trim() === '' && current) {
      continue;
    } else {
      current = undefined;
    }
  }
  return ideas;
}

/** Top-level bullets in Ideas.md that have not been linked to a card yet. */
export function parseIdeas(content: string): IdeaEntry[] {
  return collectIdeas(content.split(/\r?\n/u))
    .filter((idea) => !triagedPattern.test(idea.head))
    .map((idea) => {
      const head = idea.head.replace(blockIdPattern, '').trim();
      const text = [head, ...idea.body].filter(Boolean).join('\n');
      return { ref: ideaRef(idea.head, text), text, line: idea.index + 1 };
    })
    .filter((idea) => idea.text.length > 0);
}

/** Append a card link and a stable block id to each triaged bullet. */
export function markIdeasTriaged(
  content: string,
  links: ReadonlyMap<string, TriagedLink>,
): { content: string; marked: string[] } {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/u);
  const marked: string[] = [];
  for (const idea of collectIdeas(lines)) {
    if (triagedPattern.test(idea.head)) continue;
    const head = idea.head.replace(blockIdPattern, '').trim();
    const text = [head, ...idea.body].filter(Boolean).join('\n');
    const ref = ideaRef(idea.head, text);
    const link = links.get(ref);
    if (!link) continue;
    const prefix = lines[idea.index]!.slice(
      0,
      lines[idea.index]!.length - idea.head.length,
    );
    const alias = link.title.replace(/[[\]|]/gu, '');
    lines[idea.index] =
      `${prefix}${head} → [[Board/Cards/${link.slug}/card|${alias}]] ^${ref}`;
    marked.push(ref);
  }
  return { content: lines.join(newline), marked };
}
