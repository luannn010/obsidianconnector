import { describe, expect, it } from 'vitest';
import type {
  ProjectSnapshot,
  ProjectSyncStatus,
} from '../../src/knowledge/types.js';
import { summarizeProjectSetupAudit } from '../../src/setup/project-setup-audit.js';

const snapshot: ProjectSnapshot = {
  projectKey: 'Host-Mesh',
  snapshotId: 'snapshot-1',
  worktreeId: 'worktree-1',
  gitRevision: 'abc123',
  dbRevision: 9,
  freshness: 'current',
  architecture: [],
  completed: [],
  active: [],
  blockers: [],
  constraints: [],
  refs: [],
  budget: { limit: 800, used: 0, truncated: false, omitted: 0 },
};

const status: ProjectSyncStatus = {
  projectKey: 'Host-Mesh',
  dbRevision: 9,
  sourceFreshness: 'current',
  summary: {
    dirtyWorktrees: 0,
    staleSources: 0,
    staleEvidence: 0,
    staleProjections: 0,
    pendingJobs: 3,
    failedJobs: 0,
  },
  topIssues: [],
  topSuggestedActions: [],
  snapshots: [],
  projections: [],
  queues: { pending: 3, failed: 0 },
  conflicts: [],
  documentationFreshness: {},
  tasks: [],
};

describe('project setup snapshot audit', () => {
  it('passes when the independently read active snapshot matches the worker receipt', () => {
    const result = summarizeProjectSetupAudit({
      snapshot,
      status,
      expectedSnapshotId: 'snapshot-1',
      expectedWorktreeId: 'worktree-1',
    });

    expect(result).toEqual({
      state: 'passed',
      checks: {
        databaseConnected: true,
        snapshotReadable: true,
        snapshotMatchesReceipt: true,
        worktreeMatchesRegistration: true,
        sourceCurrent: true,
        failedJobsZero: true,
      },
      snapshot: {
        snapshotId: 'snapshot-1',
        worktreeId: 'worktree-1',
        gitRevision: 'abc123',
        dbRevision: 9,
        freshness: 'current',
      },
      sync: {
        sourceFreshness: 'current',
        pendingJobs: 3,
        failedJobs: 0,
        summary: status.summary,
        topIssues: [],
        suggestedActions: [],
      },
      problems: [],
    });
  });

  it('accepts an indexed dirty worktree when no source snapshot is stale', () => {
    const result = summarizeProjectSetupAudit({
      snapshot,
      status: {
        ...status,
        sourceFreshness: 'stale',
        summary: { ...status.summary!, dirtyWorktrees: 1, staleSources: 0 },
      },
      expectedSnapshotId: 'snapshot-1',
      expectedWorktreeId: 'worktree-1',
    });

    expect(result.state).toBe('passed');
    expect(result.checks.sourceCurrent).toBe(true);
    expect(result.sync.sourceFreshness).toBe('stale');
  });

  it('reports snapshot, freshness, and failed-job problems without hiding queue state', () => {
    const result = summarizeProjectSetupAudit({
      snapshot: { ...snapshot, freshness: 'stale' },
      status: {
        ...status,
        sourceFreshness: 'stale',
        queues: { pending: 7, failed: 2 },
        topIssues: ['Source snapshot is stale'],
      },
      expectedSnapshotId: 'snapshot-2',
      expectedWorktreeId: 'worktree-2',
    });

    expect(result.state).toBe('issues');
    expect(result.sync).toMatchObject({ pendingJobs: 7, failedJobs: 2 });
    expect(result.problems).toEqual([
      'Active snapshot snapshot-1 does not match source-sync receipt snapshot-2',
      'Active snapshot belongs to worktree worktree-1 instead of registered worktree worktree-2',
      'Source snapshot is stale',
      '2 failed project-knowledge jobs require attention',
    ]);
  });

  it('promotes store audit issues and conflicts into the reported problems', () => {
    const result = summarizeProjectSetupAudit({
      snapshot,
      status: {
        ...status,
        topIssues: ['One evidence reference cannot be resolved'],
        conflicts: [{ kind: 'projection_drift' }],
      },
      expectedSnapshotId: 'snapshot-1',
      expectedWorktreeId: 'worktree-1',
    });

    expect(result.state).toBe('issues');
    expect(result.problems).toEqual([
      'One evidence reference cannot be resolved',
      '1 project-knowledge conflict requires attention',
    ]);
  });
});
