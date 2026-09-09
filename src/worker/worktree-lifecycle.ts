import path from 'node:path';
import type { WorkerProject } from './knowledge-worker.js';

interface Queryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
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
): Promise<{
  registered: number;
  unmanaged: number;
  removed: number;
  indexedWorktrees: WorktreeIndexResult[];
}> {
  const primaryPath = path.resolve(project.repositoryPath);
  const primary = await worker.reconcile(project);
  const worktrees = await worker.syncWorktrees(project);
  const indexedWorktrees: WorktreeIndexResult[] = [
    { worktreePath: primaryPath, ...primary },
  ];
  const seen = new Set([primaryPath.toLowerCase()]);
  for (const discoveredPath of worktrees.paths) {
    const worktreePath = path.resolve(discoveredPath);
    const normalized = worktreePath.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const indexed = await worker.reconcile(
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
