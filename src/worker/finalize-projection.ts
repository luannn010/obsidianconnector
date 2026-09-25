import type {
  ProjectSyncStatus,
  SyncSuggestedAction,
} from '../knowledge/types.js';
import { runStatusFirstSync } from './status-first-sync.js';

type ProjectionState = 'current' | 'drifted' | 'stale' | 'pending' | string;

export interface FinalizeProjectionOptions {
  projectKey: string;
  timeoutMs: number;
  pollMs: number;
}

export interface FinalizeProjectionOperations {
  getStatus(): Promise<ProjectSyncStatus>;
  processEmbeddings(): Promise<number>;
  publishVault(): Promise<unknown>;
  sleep(ms: number): Promise<void>;
}

export interface QueueSummary {
  pending: number;
  failed: number;
}

export interface ProjectionSummary {
  total: number;
  current: number;
  drifted: number;
  stale: number;
  pending: number;
  other: number;
}

export interface FinalizeProjectionResult {
  projectKey: string;
  state: 'current' | 'completed' | 'blocked' | 'timeout';
  reason?: string;
  dbRevision: number;
  before: { queues: QueueSummary };
  after: { queues: QueueSummary };
  executedActions: SyncSuggestedAction['action'][];
  deferredActions: SyncSuggestedAction[];
  unresolvedBlockers: string[];
  projections: ProjectionSummary;
  touchedPaths: string[];
  timeoutMs: number;
}

function queueSummary(status: ProjectSyncStatus): QueueSummary {
  return {
    pending: status.summary?.pendingJobs ?? status.queues.pending,
    failed: status.summary?.failedJobs ?? status.queues.failed,
  };
}

function projectionState(row: unknown): ProjectionState | undefined {
  if (!row || typeof row !== 'object' || !('state' in row)) return undefined;
  const state = (row as { state?: unknown }).state;
  return typeof state === 'string' ? state : undefined;
}

function projectionPath(row: unknown): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const relativePath = (row as { relative_path?: unknown }).relative_path;
  if (typeof relativePath === 'string') return relativePath;
  const path = (row as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
}

function summarizeProjections(status: ProjectSyncStatus): ProjectionSummary {
  const summary: ProjectionSummary = {
    total: status.projections.length,
    current: 0,
    drifted: 0,
    stale: 0,
    pending: 0,
    other: 0,
  };
  for (const projection of status.projections) {
    switch (projectionState(projection)) {
      case 'current':
        summary.current++;
        break;
      case 'drifted':
        summary.drifted++;
        break;
      case 'stale':
        summary.stale++;
        break;
      case 'pending':
        summary.pending++;
        break;
      default:
        summary.other++;
        break;
    }
  }
  return summary;
}

function projectionPaths(status: ProjectSyncStatus): string[] {
  return [
    ...new Set(
      status.projections
        .map((projection) => projectionPath(projection))
        .filter((path): path is string => Boolean(path)),
    ),
  ].sort();
}

function hasProjectionWork(status: ProjectSyncStatus): boolean {
  const queues = queueSummary(status);
  return (
    queues.pending > 0 ||
    (status.topSuggestedActions ?? []).some(
      (action) => action.action === 'FINALIZE_PROJECTION',
    ) ||
    summarizeProjections(status).stale > 0 ||
    summarizeProjections(status).pending > 0
  );
}

function isProjectionCurrent(status: ProjectSyncStatus): boolean {
  const queues = queueSummary(status);
  const projections = summarizeProjections(status);
  return (
    queues.pending === 0 &&
    queues.failed === 0 &&
    projections.drifted === 0 &&
    projections.stale === 0 &&
    projections.pending === 0 &&
    !(status.topSuggestedActions ?? []).some(
      (action) => action.action === 'FINALIZE_PROJECTION',
    )
  );
}

function result(
  state: FinalizeProjectionResult['state'],
  before: ProjectSyncStatus,
  after: ProjectSyncStatus,
  options: FinalizeProjectionOptions,
  executedActions: SyncSuggestedAction['action'][] = [],
  deferredActions: SyncSuggestedAction[] = [],
  reason?: string,
): FinalizeProjectionResult {
  return {
    projectKey: options.projectKey,
    state,
    ...(reason ? { reason } : {}),
    dbRevision: after.dbRevision,
    before: { queues: queueSummary(before) },
    after: { queues: queueSummary(after) },
    executedActions,
    deferredActions,
    unresolvedBlockers: after.topIssues ?? [],
    projections: summarizeProjections(after),
    touchedPaths: projectionPaths(after),
    timeoutMs: options.timeoutMs,
  };
}

export async function finalizeProjectProjection(
  operations: FinalizeProjectionOperations,
  options: FinalizeProjectionOptions,
): Promise<FinalizeProjectionResult> {
  const before = await operations.getStatus();
  const beforeQueues = queueSummary(before);
  if (beforeQueues.failed > 0)
    return result('blocked', before, before, options, [], [], 'failed-jobs');
  if (before.conflicts.length > 0)
    return result(
      'blocked',
      before,
      before,
      options,
      [],
      [],
      'projection-conflicts',
    );
  if (!hasProjectionWork(before) && isProjectionCurrent(before))
    return result('current', before, before, options);

  const nonProjectionActions = (before.topSuggestedActions ?? []).filter(
    (action) => action.action !== 'FINALIZE_PROJECTION',
  );
  if (nonProjectionActions.length > 0)
    return result(
      'blocked',
      before,
      before,
      options,
      [],
      nonProjectionActions,
      'non-projection-actions',
    );

  const plan = await runStatusFirstSync(
    {
      getStatus: async () => before,
      reindexSource: async () => undefined,
      updateKnowledge: async () => undefined,
      verifyEvidence: async () => undefined,
      finalizeProjection: async () => {
        await operations.processEmbeddings();
        await operations.publishVault();
      },
    },
    { mode: 'deep' },
  );

  let after = await operations.getStatus();
  let elapsed = 0;
  while (!isProjectionCurrent(after) && elapsed < options.timeoutMs) {
    if (queueSummary(after).failed > 0)
      return result(
        'blocked',
        before,
        after,
        options,
        plan.executedActions,
        plan.deferredActions,
        'failed-jobs',
      );
    if (after.conflicts.length > 0)
      return result(
        'blocked',
        before,
        after,
        options,
        plan.executedActions,
        plan.deferredActions,
        'projection-conflicts',
      );
    await operations.sleep(options.pollMs);
    elapsed += options.pollMs;
    after = await operations.getStatus();
  }

  if (!isProjectionCurrent(after))
    return result(
      'timeout',
      before,
      after,
      options,
      plan.executedActions,
      plan.deferredActions,
      queueSummary(after).pending > 0 ? 'pending-jobs' : 'projection-stale',
    );

  return result(
    plan.executedActions.length > 0 ? 'completed' : 'current',
    before,
    after,
    options,
    plan.executedActions,
    plan.deferredActions,
  );
}
