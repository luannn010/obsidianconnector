import matter from 'gray-matter';
import { IdeaError } from './errors.js';

export const BOARD_DIRECTORY = 'Board';
export const CARDS_DIRECTORY = 'Board/Cards';

export const CARD_STATUSES = [
  'backlog',
  'planning',
  'plan-review',
  'ready',
  'building',
  'review',
  'done',
] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const PROTOTYPE_TYPES = ['html', 'diagram', 'spike'] as const;
export type PrototypeType = (typeof PROTOTYPE_TYPES)[number];

export const ARTIFACT_TYPES = ['plan', ...PROTOTYPE_TYPES] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const CARD_PRIORITIES = ['low', 'medium', 'high'] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];

export interface CardArtifact {
  type: ArtifactType;
  title: string;
  path?: string;
  branch?: string;
}

export interface CardFrontmatter {
  kind: 'work_item';
  card: true;
  project_key: string;
  title: string;
  status: CardStatus;
  priority: CardPriority;
  idea_ref: string;
  prototypes_requested: PrototypeType[];
  artifacts: CardArtifact[];
  spike_branch: string | null;
  review_note: string | null;
  knowledge_id: string | null;
  created: string;
}

export interface CardContent {
  title: string;
  priority?: CardPriority;
  problem: string;
  proposal: string;
  acceptance: string[];
  prototypes?: PrototypeType[];
}

const slugPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60)
    .replace(/-+$/u, '');
  return slug || 'idea';
}

export function uniqueSlug(title: string, taken: ReadonlySet<string>): string {
  const base = slugify(title);
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function assertCardSlug(slug: string): string {
  if (!slugPattern.test(slug))
    throw new IdeaError(`Invalid card slug: ${slug}`);
  return slug;
}

export function assertBranchName(branch: string): string {
  if (!branchPattern.test(branch) || branch.includes('..'))
    throw new IdeaError(`Invalid spike branch name: ${branch}`);
  return branch;
}

export function isCardStatus(value: unknown): value is CardStatus {
  return (CARD_STATUSES as readonly unknown[]).includes(value);
}

export function cardDirectory(slug: string): string {
  return `${CARDS_DIRECTORY}/${assertCardSlug(slug)}`;
}

export function cardNotePath(slug: string): string {
  return `${cardDirectory(slug)}/card.md`;
}

/** Card-folder-relative file for an artifact; spikes live on a branch instead. */
export function artifactFileName(
  type: Exclude<ArtifactType, 'spike'>,
  title: string,
  diagramFormat: 'mermaid' | 'svg' = 'mermaid',
): string {
  if (type === 'plan') return 'plan.md';
  const extension =
    type === 'html' ? 'html' : diagramFormat === 'svg' ? 'svg' : 'mmd';
  return `prototypes/${slugify(title)}.${extension}`;
}

export function renderCardNote(
  projectKey: string,
  ideaRef: string,
  content: CardContent,
  created: string,
): { frontmatter: CardFrontmatter; markdown: string } {
  const frontmatter: CardFrontmatter = {
    kind: 'work_item',
    card: true,
    project_key: projectKey,
    title: content.title,
    status: 'backlog',
    priority: content.priority ?? 'medium',
    idea_ref: ideaRef,
    prototypes_requested: [...new Set(content.prototypes ?? [])],
    artifacts: [],
    spike_branch: null,
    review_note: null,
    knowledge_id: null,
    created,
  };
  const body = [
    `# ${content.title}`,
    '',
    '## Problem',
    '',
    content.problem.trim(),
    '',
    '## Proposal',
    '',
    content.proposal.trim(),
    '',
    '## Acceptance criteria',
    '',
    ...content.acceptance.map((item) => `- [ ] ${item.trim()}`),
    '',
  ].join('\n');
  return {
    frontmatter,
    markdown: matter.stringify(body, frontmatter as unknown as object),
  };
}

export function cardKnowledgeBody(content: CardContent): string {
  return [
    content.problem.trim(),
    '',
    `Proposal: ${content.proposal.trim()}`,
    '',
    'Acceptance criteria:',
    ...content.acceptance.map((item) => `- ${item.trim()}`),
  ].join('\n');
}

export function upsertArtifact(
  artifacts: readonly CardArtifact[],
  next: CardArtifact,
): CardArtifact[] {
  const key = (artifact: CardArtifact) =>
    artifact.path ?? `branch:${artifact.branch ?? ''}`;
  return [...artifacts.filter((item) => key(item) !== key(next)), next];
}
