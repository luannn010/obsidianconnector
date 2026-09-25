import { describe, expect, it, vi } from 'vitest';
import type {
  ProjectSyncStatus,
  SyncSuggestedAction,
} from '../../src/knowledge/types.js';
import {
  finalizeProjectProjection,
  type FinalizeProjectionOperations,
} from '../../src/worker/finalize-projection.js';

function action(
  kind: SyncSuggestedAction['action'],
  overrides: Partial<SyncSuggestedAction> = {},
): SyncSuggestedAction {
  return {
    actionId: `${kind}:worktree-1:pending-jobs`,
    action: kind,
    summary: kind,
    worktreeId: 'worktree-1',
    changedPaths: [],
    estimatedWrites: 1,
    estimatedTokens: 180,
    ...overrides,
  };
}

function status(overrides: Partial<ProjectSyncStatus> = {}): ProjectSyncStatus {
  return {
    projectKey: 'Host-Mesh',
    dbRevision: 12,
    sourceFreshness: 'current',
    summary: {
      dirtyWorktrees: 0,
      staleSources: 0,
      staleEvidence: 0,
      staleProjections: 0,
      pendingJobs: 0,
      failedJobs: 0,
    },
    topIssues: [],
    topSuggestedActions: [],
    cacheKey: 'cache',
    fingerprint: 'fingerprint',
    compact: true,
    snapshots: [],
    projections: [],
    queues: { pending: 0, failed: 0 },
    conflicts: [],
    documentationFreshness: {},
    tasks: [],
    ...overrides,
  };
}

function operations(
  statuses: ProjectSyncStatus[],
): FinalizeProjectionOperations {
  const queue = [...statuses];
  return {
    getStatus: vi.fn(async () => queue.shift() ?? statuses.at(-1)!),
    processEmbeddings: vi.fn(async () => 0),
    publishVault: vi.fn(async () => []),
    sleep: vi.fn(async () => undefined),
  };
}

describe('projection finalization wrapper', () => {
  it('returns current without mutating the vault when there is no pending work', async () => {
    const ops = operations([status()]);

    const result = await finalizeProjectProjection(ops, {
      projectKey: 'Host-Mesh',
      timeoutMs: 10_000,
      pollMs: 1_000,
    });

    expect(result.state).toBe('current');
    expect(result.before.queues.pending).toBe(0);
    expect(result.after.queues.pending).toBe(0);
    expect(ops.processEmbeddings).not.toHaveBeenCalled();
    expect(ops.publishVault).not.toHaveBeenCalled();
  });

  it('runs projection finalization in deep mode and waits until pending jobs drain', async () => {
    const ops = operations([
      status({
        summary: {
          dirtyWorktrees: 0,
          staleSources: 0,
          staleEvidence: 0,
          staleProjections: 0,
          pendingJobs: 3,
          failedJobs: 0,
        },
        queues: { pending: 3, failed: 0 },
        topIssues: ['3 pending sync job(s) have not completed'],
        topSuggestedActions: [action('FINALIZE_PROJECTION')],
      }),
      status({
        projections: [
          {
            relative_path: 'Published/Architecture.md',
            state: 'current',
            db_revision: 12,
          },
        ],
      }),
    ]);

    const result = await finalizeProjectProjection(ops, {
      projectKey: 'Host-Mesh',
      timeoutMs: 10_000,
      pollMs: 1_000,
    });

    expect(result.state).toBe('completed');
    expect(result.executedActions).toEqual(['FINALIZE_PROJECTION']);
    expect(result.after.queues.pending).toBe(0);
    expect(result.projections.current).toBe(1);
    expect(result.touchedPaths).toEqual(['Published/Architecture.md']);
    expect(ops.processEmbeddings).toHaveBeenCalledTimes(1);
    expect(ops.publishVault).toHaveBeenCalledTimes(1);
    expect(ops.sleep).not.toHaveBeenCalled();
  });

  it('blocks before finalization when failed jobs are present', async () => {
    const ops = operations([
      status({
        summary: {
          dirtyWorktrees: 0,
          staleSources: 0,
          staleEvidence: 0,
          staleProjections: 0,
          pendingJobs: 0,
          failedJobs: 2,
        },
        queues: { pending: 0, failed: 2 },
        topIssues: ['2 failed sync job(s) require manual review'],
      }),
    ]);

    const result = await finalizeProjectProjection(ops, {
      projectKey: 'Host-Mesh',
      timeoutMs: 10_000,
      pollMs: 1_000,
    });

    expect(result.state).toBe('blocked');
    expect(result.reason).toBe('failed-jobs');
    expect(ops.publishVault).not.toHaveBeenCalled();
  });

  it('blocks before finalization when unresolved projection conflicts exist', async () => {
    const ops = operations([
      status({
        conflicts: [{ id: 'conflict-1' }],
        topSuggestedActions: [action('FINALIZE_PROJECTION')],
      }),
    ]);

    const result = await finalizeProjectProjection(ops, {
      projectKey: 'Host-Mesh',
      timeoutMs: 10_000,
      pollMs: 1_000,
    });

    expect(result.state).toBe('blocked');
    expect(result.reason).toBe('projection-conflicts');
    expect(ops.publishVault).not.toHaveBeenCalled();
  });

  it('times out when pending jobs never drain', async () => {
    const pending = status({
      summary: {
        dirtyWorktrees: 0,
        staleSources: 0,
        staleEvidence: 0,
        staleProjections: 0,
        pendingJobs: 1,
        failedJobs: 0,
      },
      queues: { pending: 1, failed: 0 },
      topSuggestedActions: [action('FINALIZE_PROJECTION')],
    });
    const ops = operations([pending, pending, pending]);

    const result = await finalizeProjectProjection(ops, {
      projectKey: 'Host-Mesh',
      timeoutMs: 2_000,
      pollMs: 1_000,
    });

    expect(result.state).toBe('timeout');
    expect(result.reason).toBe('pending-jobs');
    expect(result.after.queues.pending).toBe(1);
    expect(ops.sleep).toHaveBeenCalledTimes(2);
  });
});
