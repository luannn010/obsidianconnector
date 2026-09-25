export interface LazyWorktree {
  id: string;
  path: string;
  branch: string;
  head: string;
  dirty: boolean;
  dirtyPathCount: number;
  snapshotId?: string;
  snapshotFresh: boolean;
  lastSeenAt: string;
}

export interface LazyProjectViewData {
  projectId: string;
  projectKey: string;
  dbRevision: number;
  generatedAt: string;
  failedJobs: number;
  projectionConflicts: number;
  staleEvidence: number;
  worktrees: LazyWorktree[];
  tasks: Array<{
    id: string;
    worktreeId: string;
    name: string;
    status: string;
    lastSeenAt: string;
  }>;
  workItems: Array<{
    title: string;
    status: string;
    verificationStatus: string;
    blocker?: string;
    worktreeIds: string[];
  }>;
  changes: Array<{
    revision: number;
    message: string;
    reason: string;
    createdAt: string;
    worktreeIds: string[];
  }>;
}

export interface LazyProjectView {
  viewId: string;
  viewType: 'project-now' | 'worktree-now';
  relativePath: string;
  body: string;
  worktreeId?: string;
  metadata: Record<string, unknown>;
}

export interface LazyViewLimits {
  words?: number;
  current?: number;
  outcomes?: number;
  attention?: number;
  nextActions?: number;
}

export interface LazyProjectViewOptions {
  projectNow?: LazyViewLimits;
  worktreeNow?: LazyViewLimits;
}

function cleanList(values: string[], limit: number): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function bullets(values: string[], empty: string): string {
  return values.length
    ? values.map((value) => `- ${value}`).join('\n')
    : `- ${empty}`;
}

function wordLimit(value: string, maximum: number): string {
  const words = value.trim().split(/\s+/u);
  return words.length <= maximum
    ? value
    : `${words.slice(0, maximum - 1).join(' ')} …`;
}

export function worktreeFolderName(
  branch: string,
  worktreeId: string,
  idLength = 8,
): string {
  const branchSlug =
    (branch.trim() || 'detached')
      .replace(/^refs\/heads\//u, '')
      .replace(/[^A-Za-z0-9._-]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'detached';
  return `${branchSlug}--${worktreeId.slice(0, idLength)}`;
}

function attentionFor(
  data: LazyProjectViewData,
  worktreeId?: string,
  limit = worktreeId ? 3 : 5,
): string[] {
  const items = data.workItems.filter(
    (item) => !worktreeId || item.worktreeIds.includes(worktreeId),
  );
  const tasks = data.tasks.filter(
    (task) => !worktreeId || task.worktreeId === worktreeId,
  );
  const staleBefore = Date.parse(data.generatedAt) - 7 * 24 * 60 * 60 * 1_000;
  const attention = [
    ...items
      .filter((item) => item.blocker?.toLowerCase().includes('decision'))
      .map(
        (item) =>
          `${item.title}: a human decision is required — ${item.blocker}`,
      ),
    ...items
      .filter(
        (item) =>
          !item.blocker?.toLowerCase().includes('decision') &&
          (item.blocker || ['blocked', 'waiting'].includes(item.status)),
      )
      .map((item) => `${item.title}: ${item.blocker ?? item.status}`),
    ...(data.failedJobs
      ? [`${data.failedJobs} synchronization job(s) failed`]
      : []),
    ...(data.projectionConflicts
      ? [`${data.projectionConflicts} projection conflict(s) need review`]
      : []),
    ...(data.staleEvidence
      ? [
          `${data.staleEvidence} required evidence reference(s) are stale or missing`,
        ]
      : []),
    ...tasks
      .filter(
        (task) =>
          task.status === 'active' && Date.parse(task.lastSeenAt) < staleBefore,
      )
      .map((task) => `${task.name}: the active agent task is stale`),
  ];
  if (worktreeId) {
    const worktree = data.worktrees.find((item) => item.id === worktreeId);
    if (worktree?.dirty)
      attention.push(
        `${worktree.dirtyPathCount} uncommitted path(s) are present in this worktree`,
      );
    if (worktree && !worktree.snapshotFresh)
      attention.push(
        'The source snapshot is behind the current worktree state',
      );
    if (
      worktree &&
      !items.some((item) =>
        ['active', 'blocked', 'waiting'].includes(item.status),
      ) &&
      !tasks.some((task) => task.status === 'active') &&
      Date.parse(worktree.lastSeenAt) < staleBefore
    )
      attention.push('This inactive worktree is a cleanup candidate');
  }
  return cleanList(attention, limit);
}

function nextActions(attention: string[], limit = 3): string[] {
  return cleanList(
    attention.map((item) =>
      item.includes('snapshot')
        ? 'Refresh the source snapshot before relying on verification status.'
        : item.includes('failed')
          ? 'Review failed synchronization jobs before publishing reference views.'
          : item.includes('stale or missing')
            ? 'Verify or update the required evidence references.'
            : item.includes('uncommitted')
              ? 'Review and either commit or intentionally retain the worktree changes.'
              : `Resolve: ${item}.`,
    ),
    limit,
  );
}

function buildProjectNow(
  data: LazyProjectViewData,
  limits: LazyViewLimits = {},
): LazyProjectView {
  const active = cleanList(
    data.workItems
      .filter((item) => ['active', 'blocked', 'waiting'].includes(item.status))
      .map(
        (item) => `${item.title} — ${item.status} (${item.verificationStatus})`,
      ),
    limits.current ?? 3,
  );
  const recent = cleanList(
    [...data.changes]
      .sort((a, b) => b.revision - a.revision)
      .map((change) => change.message),
    limits.outcomes ?? 5,
  );
  const attention = attentionFor(data, undefined, limits.attention ?? 5);
  const links = data.worktrees.map(
    (worktree) =>
      `[[Worktrees/${worktreeFolderName(worktree.branch, worktree.id)}/Now|${worktree.branch || 'detached'}]]`,
  );
  const body = `# ${data.projectKey} — Now

${data.projectKey} has ${data.worktrees.length} live Git worktree(s). ${active.length ? `${active.length} priority item(s) are shown below.` : 'No active work item is currently recorded.'}

## Current focus

${bullets(active, 'No active work is recorded.')}

## Done since the previous update

${bullets(recent, 'No recorded knowledge changes since the previous update.')}

## Needs attention

${bullets(attention, 'No immediate attention is required.')}

## Likely next actions

${bullets(nextActions(attention, limits.nextActions ?? 3), 'Continue the current verified plan.')}

## Live worktrees

${bullets(links, 'No live Git worktrees were found.')}

---
Source heads: ${data.worktrees.map((worktree) => worktree.head.slice(0, 8)).join(', ') || 'none'} · Knowledge revision: ${data.dbRevision} · Generation revision: ${data.dbRevision} · Generated ${data.generatedAt}`;
  return {
    viewId: 'project-now',
    viewType: 'project-now',
    relativePath: 'Published/00 - Now.md',
    body: wordLimit(body, limits.words ?? 600),
    metadata: { generated_at: data.generatedAt },
  };
}

function buildWorktreeNow(
  data: LazyProjectViewData,
  worktree: LazyWorktree,
  limits: LazyViewLimits = {},
): LazyProjectView {
  const tasks = data.tasks
    .filter(
      (task) => task.worktreeId === worktree.id && task.status === 'active',
    )
    .filter((task) => task.name.trim() && task.name !== 'Untitled task')
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  const items = data.workItems.filter((item) =>
    item.worktreeIds.includes(worktree.id),
  );
  const purpose = tasks[0]?.name ?? items[0]?.title;
  const current = cleanList(
    [
      ...tasks.map((task) => `${task.name} — ${task.status}`),
      ...items
        .filter((item) =>
          ['active', 'blocked', 'waiting'].includes(item.status),
        )
        .map(
          (item) =>
            `${item.title} — ${item.status} (${item.verificationStatus})`,
        ),
    ],
    limits.current ?? 3,
  );
  const recent = cleanList(
    data.changes
      .filter((change) => change.worktreeIds.includes(worktree.id))
      .sort((a, b) => b.revision - a.revision)
      .map((change) => change.message),
    limits.outcomes ?? 5,
  );
  const attention = attentionFor(data, worktree.id, limits.attention ?? 3);
  const body = `# ${worktree.branch || 'Detached worktree'} — Now

${purpose ? `This worktree is focused on: ${purpose}.` : 'This worktree’s purpose is not yet recorded.'}

## Current work

${bullets(current, 'No active task or work item is linked to this worktree.')}

## Done since the previous update

${bullets(recent, 'No recorded outcomes since the previous update.')}

## Needs attention

${bullets(attention, 'No immediate attention is required.')}

## Next actions

${bullets(nextActions(attention, limits.nextActions ?? 3), 'Continue the current work and record the next meaningful outcome.')}

---
Branch: ${worktree.branch || 'detached'} · HEAD: ${worktree.head.slice(0, 12)} · ${worktree.dirty ? 'dirty' : 'clean'} · Snapshot: ${worktree.snapshotFresh ? 'current' : 'stale'} · Last activity: ${worktree.lastSeenAt} · Knowledge revision: ${data.dbRevision}`;
  return {
    viewId: `worktree:${worktree.id}:now`,
    viewType: 'worktree-now',
    relativePath: `Published/Worktrees/${worktreeFolderName(worktree.branch, worktree.id)}/Now.md`,
    body: wordLimit(body, limits.words ?? 400),
    worktreeId: worktree.id,
    metadata: {
      branch: worktree.branch || 'detached',
      worktree_id: worktree.id,
      worktree_path: worktree.path,
      source_snapshot_id: worktree.snapshotId ?? 'unindexed',
    },
  };
}

export function buildLazyProjectViews(
  data: LazyProjectViewData,
  options: LazyProjectViewOptions = {},
): LazyProjectView[] {
  const sortedWorktrees = [...data.worktrees].sort((a, b) =>
    `${a.branch}:${a.id}`.localeCompare(`${b.branch}:${b.id}`),
  );
  const folderCounts = new Map<string, number>();
  for (const worktree of sortedWorktrees) {
    const folder = worktreeFolderName(worktree.branch, worktree.id);
    folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
  }
  return [
    buildProjectNow(data, options.projectNow),
    ...sortedWorktrees.map((worktree) => {
      const view = buildWorktreeNow(data, worktree, options.worktreeNow);
      const folder = worktreeFolderName(worktree.branch, worktree.id);
      return folderCounts.get(folder) === 1
        ? view
        : {
            ...view,
            relativePath: `Published/Worktrees/${worktreeFolderName(worktree.branch, worktree.id, 12)}/Now.md`,
          };
    }),
  ];
}
