import path from 'node:path';
import type { WorkerProject } from './knowledge-worker.js';

interface Queryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

export class ProjectNotReconciledError extends Error {
  constructor() {
    super('Project must be reconciled before worktrees are synchronized');
    this.name = 'ProjectNotReconciledError';
  }
}

export interface WorktreeIndexResult {
  worktreePath: string;
  changed: boolean;
  snapshotId: string;
  indexedFiles: number;
}

interface WorktreeSynchronizer {
  reconcile(
    project: WorkerProject,
    options?: { primaryRepositoryPath?: string },
  ): Promise<Omit<WorktreeIndexResult, 'worktreePath'>>;
  syncWorktrees(project: WorkerProject): Promise<{
    registered: number;
    unmanaged: number;
    removed: number;
    paths: string[];
  }>;
}

export async function deactivateMissingWorktrees(
  database: Queryable,
  projectId: string,
  repositoryId: string,
  registeredPaths: string[],
): Promise<string[]> {
  const normalizedPaths = registeredPaths.map((worktreePath) =>
    path.resolve(worktreePath).toLowerCase(),
  );
  const result = await database.query<{ path: string }>(
    `UPDATE project_knowledge.worktrees
     SET registered=false
     WHERE project_id=$1 AND repository_id=$2 AND registered
       AND NOT (lower(path)=ANY($3::text[]))
     RETURNING path`,
    [projectId, repositoryId, normalizedPaths],
  );
  return result.rows.map((row) => row.path);
}

export async function synchronizeProjectWorktrees(
  worker: WorktreeSynchronizer,
  project: WorkerProject,
  options: { targetPaths?: string[] } = {},
): Promise<{
  registered: number;
  unmanaged: number;
  removed: number;
  indexedWorktrees: WorktreeIndexResult[];
}> {
  const primaryPath = path.resolve(project.repositoryPath);
  const indexedWorktrees: WorktreeIndexResult[] = [];
  const seen = new Set<string>();
  let worktrees: Awaited<ReturnType<WorktreeSynchronizer['syncWorktrees']>>;
  try {
    worktrees = await worker.syncWorktrees(project);
  } catch (error) {
    if (!(error instanceof ProjectNotReconciledError)) throw error;
    indexedWorktrees.push({
      worktreePath: primaryPath,
      ...(await worker.reconcile(project)),
    });
    seen.add(primaryPath.toLowerCase());
    worktrees = await worker.syncWorktrees(project);
  }
  const targetPaths = options.targetPaths
    ? new Set(
        options.targetPaths.map((worktreePath) =>
          path.resolve(worktreePath).toLowerCase(),
        ),
      )
    : undefined;
  for (const discoveredPath of [primaryPath, ...worktrees.paths]) {
    const worktreePath = path.resolve(discoveredPath);
    const normalized = worktreePath.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (targetPaths && !targetPaths.has(normalized)) continue;
    const indexed =
      normalized === primaryPath.toLowerCase()
        ? await worker.reconcile(project)
        : await worker.reconcile(
            { ...project, repositoryPath: worktreePath },
            { primaryRepositoryPath: primaryPath },
          );
    indexedWorktrees.push({ worktreePath, ...indexed });
  }
  return {
    registered: worktrees.registered,
    unmanaged: worktrees.unmanaged,
    removed: worktrees.removed,
    indexedWorktrees,
  };
}
