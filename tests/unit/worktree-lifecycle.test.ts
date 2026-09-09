import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkerProject } from '../../src/worker/knowledge-worker.js';
import {
  deactivateMissingWorktrees,
  synchronizeProjectWorktrees,
} from '../../src/worker/worktree-lifecycle.js';

const project: WorkerProject = {
  projectKey: 'MC-Platform',
  name: 'MC-Platform',
  repositoryPath: path.resolve('C:/repo'),
  vaultPath: path.resolve('C:/vault'),
};

describe('registered worktree lifecycle', () => {
  it('reconciles each discovered feature worktree against the primary repository', async () => {
    const reconciled: Array<{
      repositoryPath: string;
      primaryRepositoryPath?: string;
    }> = [];
    const worker = {
      reconcile: async (
        input: WorkerProject,
        options?: { primaryRepositoryPath?: string },
      ) => {
        reconciled.push({
          repositoryPath: input.repositoryPath,
          ...(options?.primaryRepositoryPath
            ? { primaryRepositoryPath: options.primaryRepositoryPath }
            : {}),
        });
        return {
          changed: input.repositoryPath !== project.repositoryPath,
          snapshotId:
            input.repositoryPath === project.repositoryPath
              ? 'snapshot-main'
              : 'snapshot-feature',
          indexedFiles: input.repositoryPath === project.repositoryPath ? 0 : 3,
        };
      },
      syncWorktrees: async () => ({
        registered: 2,
        unmanaged: 0,
        removed: 0,
        paths: [
          project.repositoryPath,
          path.resolve('C:/repo/.worktrees/feature-a'),
        ],
      }),
    };

    const result = await synchronizeProjectWorktrees(worker, project);

    expect(reconciled).toEqual([
      { repositoryPath: project.repositoryPath },
      {
        repositoryPath: path.resolve('C:/repo/.worktrees/feature-a'),
        primaryRepositoryPath: project.repositoryPath,
      },
    ]);
    expect(result.indexedWorktrees).toEqual([
      {
        worktreePath: project.repositoryPath,
        changed: false,
        snapshotId: 'snapshot-main',
        indexedFiles: 0,
      },
      {
        worktreePath: path.resolve('C:/repo/.worktrees/feature-a'),
        changed: true,
        snapshotId: 'snapshot-feature',
        indexedFiles: 3,
      },
    ]);
  });

  it('reconciles only the worktrees selected by compact repair actions', async () => {
    const featurePath = path.resolve('C:/repo/.worktrees/feature-a');
    const otherPath = path.resolve('C:/repo/.worktrees/feature-b');
    const reconciled: string[] = [];
    const worker = {
      reconcile: async (input: WorkerProject) => {
        reconciled.push(input.repositoryPath);
        return {
          changed: true,
          snapshotId: `snapshot-${reconciled.length}`,
          indexedFiles: 1,
        };
      },
      syncWorktrees: async () => ({
        registered: 3,
        unmanaged: 0,
        removed: 0,
        paths: [project.repositoryPath, featurePath, otherPath],
      }),
    };

    const result = await synchronizeProjectWorktrees(worker, project, {
      targetPaths: [featurePath],
    });

    expect(reconciled).toEqual([featurePath]);
    expect(result.indexedWorktrees.map((entry) => entry.worktreePath)).toEqual([
      featurePath,
    ]);
  });

  it('marks database worktrees absent from Git as unregistered without deleting history', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const database = {
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values?: unknown[],
      ) => {
        calls.push({ sql, values });
        return {
          rows: [{ path: 'C:/repo/.worktrees/removed' }] as unknown as Row[],
        };
      },
    };

    const removed = await deactivateMissingWorktrees(
      database,
      'project-1',
      'repository-1',
      [path.resolve('C:/repo'), path.resolve('C:/repo/.worktrees/feature-a')],
    );

    expect(removed).toEqual(['C:/repo/.worktrees/removed']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('SET registered=false');
    expect(calls[0]?.sql).toContain('RETURNING path');
    expect(calls[0]?.sql).not.toContain('DELETE');
    expect(calls[0]?.values).toEqual([
      'project-1',
      'repository-1',
      [
        path.resolve('C:/repo').toLowerCase(),
        path.resolve('C:/repo/.worktrees/feature-a').toLowerCase(),
      ],
    ]);
  });
});
