import type {
  ProjectSnapshot,
  ProjectSyncStatus,
  SyncSuggestedAction,
  SyncStatusSummary,
} from '../knowledge/types.js';

export interface ProjectSetupAuditInput {
  snapshot: ProjectSnapshot;
  status: ProjectSyncStatus;
  expectedSnapshotId: string;
  expectedWorktreeId: string;
}

export interface ProjectSetupAudit {
  state: 'passed' | 'issues';
  checks: {
    databaseConnected: true;
    snapshotReadable: true;
    snapshotMatchesReceipt: boolean;
    worktreeMatchesRegistration: boolean;
    sourceCurrent: boolean;
    failedJobsZero: boolean;
  };
  snapshot: {
    snapshotId: string;
    worktreeId: string;
    gitRevision: string;
    dbRevision: number;
    freshness: ProjectSnapshot['freshness'];
  };
  sync: {
    sourceFreshness: ProjectSyncStatus['sourceFreshness'];
    pendingJobs: number;
    failedJobs: number;
    summary?: SyncStatusSummary;
    topIssues: string[];
    suggestedActions: SyncSuggestedAction[];
  };
  problems: string[];
}

export function summarizeProjectSetupAudit(
  input: ProjectSetupAuditInput,
): ProjectSetupAudit {
  const snapshotMatchesReceipt =
    input.snapshot.snapshotId === input.expectedSnapshotId;
  const worktreeMatchesRegistration =
    input.snapshot.worktreeId === input.expectedWorktreeId;
  const sourceCurrent =
    input.snapshot.freshness === 'current' &&
    (input.status.summary
      ? input.status.summary.staleSources === 0
      : input.status.sourceFreshness === 'current');
  const failedJobsZero = input.status.queues.failed === 0;
  const problems: string[] = [];

  if (!snapshotMatchesReceipt)
    problems.push(
      `Active snapshot ${input.snapshot.snapshotId} does not match source-sync receipt ${input.expectedSnapshotId}`,
    );
  if (!worktreeMatchesRegistration)
    problems.push(
      `Active snapshot belongs to worktree ${input.snapshot.worktreeId} instead of registered worktree ${input.expectedWorktreeId}`,
    );
  if (!sourceCurrent) problems.push('Source snapshot is stale');
  if (!failedJobsZero)
    problems.push(
      `${input.status.queues.failed} failed project-knowledge jobs require attention`,
    );
  for (const issue of input.status.topIssues ?? []) {
    if (!problems.includes(issue)) problems.push(issue);
  }
  if (input.status.conflicts.length > 0)
    problems.push(
      `${input.status.conflicts.length} project-knowledge conflict${input.status.conflicts.length === 1 ? '' : 's'} require${input.status.conflicts.length === 1 ? 's' : ''} attention`,
    );

  return {
    state: problems.length === 0 ? 'passed' : 'issues',
    checks: {
      databaseConnected: true,
      snapshotReadable: true,
      snapshotMatchesReceipt,
      worktreeMatchesRegistration,
      sourceCurrent,
      failedJobsZero,
    },
    snapshot: {
      snapshotId: input.snapshot.snapshotId,
      worktreeId: input.snapshot.worktreeId,
      gitRevision: input.snapshot.gitRevision,
      dbRevision: input.snapshot.dbRevision,
      freshness: input.snapshot.freshness,
    },
    sync: {
      sourceFreshness: input.status.sourceFreshness,
      pendingJobs: input.status.queues.pending,
      failedJobs: input.status.queues.failed,
      ...(input.status.summary ? { summary: input.status.summary } : {}),
      topIssues: input.status.topIssues ?? [],
      suggestedActions: input.status.topSuggestedActions ?? [],
    },
    problems,
  };
}
