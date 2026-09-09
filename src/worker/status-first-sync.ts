import type {
  ProjectSyncStatus,
  SyncSuggestedAction,
} from '../knowledge/types.js';

export type SyncRunMode = 'quick' | 'deep';

export interface StatusFirstSyncOperations {
  getStatus(): Promise<ProjectSyncStatus>;
  reindexSource(actions: SyncSuggestedAction[]): Promise<void>;
  updateKnowledge(actions: SyncSuggestedAction[]): Promise<void>;
  verifyEvidence(actions: SyncSuggestedAction[]): Promise<void>;
  finalizeProjection(actions: SyncSuggestedAction[]): Promise<void>;
}

export interface StatusFirstSyncOptions {
  mode?: SyncRunMode;
  allowFailedJobs?: boolean;
  forceReindex?: boolean;
}

export interface StatusFirstSyncResult {
  state: 'current' | 'blocked' | 'completed' | 'deferred';
  cacheKey?: string;
  fingerprint?: string;
  requiresOverride: boolean;
  executedActions: SyncSuggestedAction['action'][];
  deferredActions: SyncSuggestedAction[];
  unresolvedBlockers: string[];
}

const actionOrder: SyncSuggestedAction['action'][] = [
  'REINDEX_SOURCE',
  'UPDATE_KNOWLEDGE',
  'VERIFY_EVIDENCE',
  'FINALIZE_PROJECTION',
];

export async function runStatusFirstSync(
  operations: StatusFirstSyncOperations,
  options: StatusFirstSyncOptions = {},
): Promise<StatusFirstSyncResult> {
  const status = await operations.getStatus();
  const actions = status.topSuggestedActions ?? [];
  const unresolvedBlockers = status.topIssues ?? [];
  const failedJobs = status.summary?.failedJobs ?? status.queues.failed;
  const base = {
    ...(status.cacheKey ? { cacheKey: status.cacheKey } : {}),
    ...(status.fingerprint ? { fingerprint: status.fingerprint } : {}),
    unresolvedBlockers,
  };

  if (failedJobs > 0 && !options.allowFailedJobs) {
    return {
      ...base,
      state: 'blocked',
      requiresOverride: true,
      executedActions: [],
      deferredActions: actions,
    };
  }

  if (
    status.sourceFreshness === 'current' &&
    actions.length === 0 &&
    !options.forceReindex
  ) {
    return {
      ...base,
      state: 'current',
      requiresOverride: false,
      executedActions: [],
      deferredActions: [],
    };
  }

  const grouped = new Map<
    SyncSuggestedAction['action'],
    SyncSuggestedAction[]
  >();
  for (const kind of actionOrder)
    grouped.set(
      kind,
      actions.filter((action) => action.action === kind),
    );

  const executedActions: SyncSuggestedAction['action'][] = [];
  if (options.forceReindex || grouped.get('REINDEX_SOURCE')!.length > 0) {
    await operations.reindexSource(grouped.get('REINDEX_SOURCE')!);
    executedActions.push('REINDEX_SOURCE');
  }
  if (grouped.get('UPDATE_KNOWLEDGE')!.length > 0) {
    await operations.updateKnowledge(grouped.get('UPDATE_KNOWLEDGE')!);
    executedActions.push('UPDATE_KNOWLEDGE');
  }
  if (grouped.get('VERIFY_EVIDENCE')!.length > 0) {
    await operations.verifyEvidence(grouped.get('VERIFY_EVIDENCE')!);
    executedActions.push('VERIFY_EVIDENCE');
  }

  const projectionActions = grouped.get('FINALIZE_PROJECTION')!;
  const projectionOnly =
    projectionActions.length > 0 &&
    actions.every((action) => action.action === 'FINALIZE_PROJECTION');
  const deferProjection = projectionOnly && options.mode !== 'deep';
  if (projectionActions.length > 0 && !deferProjection) {
    await operations.finalizeProjection(projectionActions);
    executedActions.push('FINALIZE_PROJECTION');
  }

  const deferredActions = deferProjection ? projectionActions : [];
  return {
    ...base,
    state:
      executedActions.length > 0
        ? 'completed'
        : deferredActions.length > 0 || unresolvedBlockers.length > 0
          ? 'deferred'
          : 'current',
    requiresOverride: false,
    executedActions,
    deferredActions,
  };
}
