import { describe, expect, it, vi } from 'vitest';
import type {
  ProjectSyncStatus,
  SyncSuggestedAction,
} from '../../src/knowledge/types.js';
import { runStatusFirstSync } from '../../src/worker/status-first-sync.js';

function action(
  kind: SyncSuggestedAction['action'],
  overrides: Partial<SyncSuggestedAction> = {},
): SyncSuggestedAction {
  return {
    actionId: `${kind}:worktree-1:Auth`,
    action: kind,
    summary: kind,
    worktreeId: 'worktree-1',
    domain: 'Auth',
    changedPaths: [],
    estimatedWrites: 1,
    estimatedTokens: 100,
    ...overrides,
  };
}

function status(overrides: Partial<ProjectSyncStatus> = {}): ProjectSyncStatus {
  return {
    projectKey: 'MC-Platform',
    dbRevision: 4,
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

function operations(syncStatus: ProjectSyncStatus) {
  return {
    getStatus: vi.fn(async () => syncStatus),
    reindexSource: vi.fn(async (actions: SyncSuggestedAction[]) => {
      void actions;
    }),
    updateKnowledge: vi.fn(async (actions: SyncSuggestedAction[]) => {
      void actions;
    }),
    verifyEvidence: vi.fn(async (actions: SyncSuggestedAction[]) => {
      void actions;
    }),
    finalizeProjection: vi.fn(async (actions: SyncSuggestedAction[]) => {
      void actions;
    }),
  };
}

describe('status-first sync runner', () => {
  it('ends after one compact status read when the project is current', async () => {
    const ops = operations(status());

    const result = await runStatusFirstSync(ops);

    expect(result.state).toBe('current');
    expect(ops.getStatus).toHaveBeenCalledTimes(1);
    expect(ops.reindexSource).not.toHaveBeenCalled();
    expect(ops.updateKnowledge).not.toHaveBeenCalled();
    expect(ops.verifyEvidence).not.toHaveBeenCalled();
    expect(ops.finalizeProjection).not.toHaveBeenCalled();
  });

  it('blocks automatic actions when failed jobs require an override', async () => {
    const ops = operations(
      status({
        sourceFreshness: 'stale',
        summary: {
          dirtyWorktrees: 0,
          staleSources: 1,
          staleEvidence: 0,
          staleProjections: 0,
          pendingJobs: 0,
          failedJobs: 2,
        },
        topIssues: ['2 failed sync jobs require manual review'],
        topSuggestedActions: [action('REINDEX_SOURCE')],
      }),
    );

    const result = await runStatusFirstSync(ops);

    expect(result.state).toBe('blocked');
    expect(result.requiresOverride).toBe(true);
    expect(result.unresolvedBlockers).toEqual([
      '2 failed sync jobs require manual review',
    ]);
    expect(ops.reindexSource).not.toHaveBeenCalled();
  });

  it('executes only listed actions in dependency-safe order', async () => {
    const calls: string[] = [];
    const update = action('UPDATE_KNOWLEDGE', {
      changedPaths: ['services/auth/src/token.ts'],
      evidenceRefs: ['chunk:00000000-0000-4000-8000-000000000001'],
      dependsOn: ['REINDEX_SOURCE:worktree-1:Auth'],
    });
    const ops = operations(
      status({
        sourceFreshness: 'stale',
        topSuggestedActions: [
          action('FINALIZE_PROJECTION'),
          action('VERIFY_EVIDENCE'),
          update,
          action('REINDEX_SOURCE'),
        ],
      }),
    );
    ops.reindexSource.mockImplementation(async () => {
      calls.push('REINDEX_SOURCE');
    });
    ops.updateKnowledge.mockImplementation(async (actions) => {
      calls.push('UPDATE_KNOWLEDGE');
      expect(actions).toEqual([update]);
    });
    ops.verifyEvidence.mockImplementation(async () => {
      calls.push('VERIFY_EVIDENCE');
    });
    ops.finalizeProjection.mockImplementation(async () => {
      calls.push('FINALIZE_PROJECTION');
    });

    const result = await runStatusFirstSync(ops);

    expect(calls).toEqual([
      'REINDEX_SOURCE',
      'UPDATE_KNOWLEDGE',
      'VERIFY_EVIDENCE',
      'FINALIZE_PROJECTION',
    ]);
    expect(result.executedActions).toEqual(calls);
    expect(ops.getStatus).toHaveBeenCalledTimes(1);
  });

  it('defers a projection-only action in quick mode and runs it in deep mode', async () => {
    const projectionStatus = status({
      sourceFreshness: 'stale',
      topSuggestedActions: [action('FINALIZE_PROJECTION')],
    });
    const quickOps = operations(projectionStatus);
    const deepOps = operations(projectionStatus);

    const quick = await runStatusFirstSync(quickOps);
    const deep = await runStatusFirstSync(deepOps, { mode: 'deep' });

    expect(quick.state).toBe('deferred');
    expect(quickOps.finalizeProjection).not.toHaveBeenCalled();
    expect(deep.state).toBe('completed');
    expect(deepOps.finalizeProjection).toHaveBeenCalledTimes(1);
  });

  it('can force a source refresh after a filesystem event while still reading status first', async () => {
    const calls: string[] = [];
    const ops = operations(status());
    ops.getStatus.mockImplementation(async () => {
      calls.push('STATUS');
      return status();
    });
    ops.reindexSource.mockImplementation(async () => {
      calls.push('REINDEX_SOURCE');
    });

    const result = await runStatusFirstSync(ops, { forceReindex: true });

    expect(calls).toEqual(['STATUS', 'REINDEX_SOURCE']);
    expect(result.executedActions).toEqual(['REINDEX_SOURCE']);
  });
});
