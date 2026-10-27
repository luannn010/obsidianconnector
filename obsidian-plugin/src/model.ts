// Pure card model helpers. No `obsidian` imports so they stay unit-testable.

export const BOARD_DIR = 'Board';
export const CARDS_DIR = `${BOARD_DIR}/Cards`;
export const PROJECT_FILE = `${BOARD_DIR}/.project.json`;

export const STATUSES = [
  'backlog',
  'planning',
  'plan-review',
  'ready',
  'building',
  'review',
  'done',
] as const;
export type CardStatus = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<CardStatus, string> = {
  backlog: 'Backlog',
  planning: 'Planning',
  'plan-review': 'Plan review',
  ready: 'Ready',
  building: 'Building',
  review: 'Review',
  done: 'Done',
};

export const PROTOTYPE_TYPES = ['html', 'diagram', 'spike'] as const;
export type PrototypeType = (typeof PROTOTYPE_TYPES)[number];

export type ArtifactType = 'plan' | PrototypeType;

export interface CardArtifact {
  type: ArtifactType;
  title: string;
  /** Relative to the card folder. Absent for spikes. */
  path?: string;
  branch?: string;
}

export interface Card {
  slug: string;
  /** Vault path of card.md. */
  filePath: string;
  /** Vault path of the card folder. */
  folder: string;
  projectKey: string;
  title: string;
  status: CardStatus;
  priority: string;
  ideaRef: string;
  prototypesRequested: PrototypeType[];
  artifacts: CardArtifact[];
  spikeBranch: string;
  reviewNote: string;
}

export function isStatus(value: unknown): value is CardStatus {
  return (
    typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
  );
}

export function normalizeStatus(value: unknown): CardStatus {
  if (typeof value !== 'string') return 'backlog';
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return isStatus(normalized) ? normalized : 'backlog';
}

/** Returns the slug for `Board/Cards/<slug>/card.md`, otherwise null. */
export function cardSlugFromPath(path: string): string | null {
  const match = /^Board\/Cards\/([^/]+)\/card\.md$/.exec(
    path.replace(/\\/g, '/'),
  );
  return match?.[1] ?? null;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return '';
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map(asString).filter((item) => item.length > 0);
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function parsePrototypeTypes(value: unknown): PrototypeType[] {
  const result: PrototypeType[] = [];
  for (const item of asStringList(value)) {
    const lower = item.toLowerCase();
    if (
      (PROTOTYPE_TYPES as readonly string[]).includes(lower) &&
      !result.includes(lower as PrototypeType)
    ) {
      result.push(lower as PrototypeType);
    }
  }
  return result;
}

export function parseArtifacts(value: unknown): CardArtifact[] {
  if (!Array.isArray(value)) return [];
  const artifacts: CardArtifact[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const type = asString(entry.type).toLowerCase();
    if (
      type !== 'plan' &&
      !(PROTOTYPE_TYPES as readonly string[]).includes(type)
    )
      continue;
    const path = asString(entry.path).replace(/\\/g, '/');
    const branch = asString(entry.branch);
    if (!path && !branch) continue;
    if (path && !isSafeRelativePath(path)) continue;
    artifacts.push({
      type: type as ArtifactType,
      title: asString(entry.title) || path || branch,
      ...(path ? { path } : {}),
      ...(branch ? { branch } : {}),
    });
  }
  return artifacts;
}

/** Rejects absolute paths and `..` segments so artifacts stay inside the card folder. */
export function isSafeRelativePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized)
  )
    return false;
  return !normalized.split('/').some((segment) => segment === '..');
}

export function parseCard(
  filePath: string,
  frontmatter: Record<string, unknown> | undefined,
): Card | null {
  const slug = cardSlugFromPath(filePath);
  if (!slug || !frontmatter || frontmatter.card !== true) return null;
  return {
    slug,
    filePath,
    folder: `${CARDS_DIR}/${slug}`,
    projectKey: asString(frontmatter.project_key),
    title: asString(frontmatter.title) || slug,
    status: normalizeStatus(frontmatter.status),
    priority: asString(frontmatter.priority),
    ideaRef: asString(frontmatter.idea_ref),
    prototypesRequested: parsePrototypeTypes(frontmatter.prototypes_requested),
    artifacts: parseArtifacts(frontmatter.artifacts),
    spikeBranch: asString(frontmatter.spike_branch),
    reviewNote: asString(frontmatter.review_note),
  };
}

export type PrototypeKind =
  'html' | 'mermaid' | 'svg' | 'markdown' | 'spike' | 'other';

export interface Prototype {
  title: string;
  kind: PrototypeKind;
  /** Vault path, absent for spikes. */
  vaultPath?: string;
  branch?: string;
}

export function prototypeKind(artifact: CardArtifact): PrototypeKind {
  if (artifact.type === 'spike' || (!artifact.path && artifact.branch))
    return 'spike';
  const path = (artifact.path ?? '').toLowerCase();
  if (path.endsWith('.html') || path.endsWith('.htm')) return 'html';
  if (path.endsWith('.mmd') || path.endsWith('.mermaid')) return 'mermaid';
  if (path.endsWith('.svg')) return 'svg';
  if (path.endsWith('.md')) return 'markdown';
  return 'other';
}

/** Prototype artifacts (everything except the plan), plus the spike branch when not listed. */
export function cardPrototypes(card: Card): Prototype[] {
  const prototypes: Prototype[] = [];
  for (const artifact of card.artifacts) {
    if (artifact.type === 'plan') continue;
    const kind = prototypeKind(artifact);
    prototypes.push({
      title: artifact.title,
      kind,
      ...(artifact.path
        ? { vaultPath: `${card.folder}/${artifact.path}` }
        : {}),
      ...(artifact.branch ? { branch: artifact.branch } : {}),
    });
  }
  if (
    card.spikeBranch &&
    !prototypes.some((item) => item.branch === card.spikeBranch)
  ) {
    prototypes.push({
      title: 'Spike',
      kind: 'spike',
      branch: card.spikeBranch,
    });
  }
  return prototypes;
}

export function planPath(card: Card): string {
  const plan = card.artifacts.find(
    (artifact) => artifact.type === 'plan' && artifact.path,
  );
  return `${card.folder}/${plan?.path ?? 'plan.md'}`;
}

export function groupByStatus(cards: Card[]): Record<CardStatus, Card[]> {
  const columns = Object.fromEntries(
    STATUSES.map((status) => [status, [] as Card[]]),
  ) as Record<CardStatus, Card[]>;
  for (const card of cards) columns[card.status].push(card);
  const rank = (priority: string): number => {
    const order = [
      'p0',
      'urgent',
      'critical',
      'p1',
      'high',
      'p2',
      'medium',
      'normal',
      'p3',
      'low',
    ];
    const index = order.indexOf(priority.toLowerCase());
    return index === -1 ? order.length : index;
  };
  for (const status of STATUSES) {
    columns[status].sort(
      (a, b) =>
        rank(a.priority) - rank(b.priority) || a.title.localeCompare(b.title),
    );
  }
  return columns;
}

export interface ProjectInfo {
  projectKey: string;
  repoPath: string;
}

export function parseProjectInfo(text: string): ProjectInfo | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const projectKey = asString(value.projectKey);
    const repoPath = asString(value.repoPath);
    if (!projectKey && !repoPath) return null;
    return { projectKey, repoPath };
  } catch {
    return null;
  }
}
