import path from 'node:path';
import type { Pool } from 'pg';
import type {
  EmbeddingProvider,
  PgPoolLike,
} from '../knowledge/pg-store.js';
import { PgKnowledgeStore } from '../knowledge/pg-store.js';
import type {
  FinalizeProjectionInput,
  ProjectSyncActionInput,
  ProjectSyncActionRunner,
  ProjectSyncStatus,
  SyncSuggestedAction,
} from '../knowledge/types.js';
import { drainQueueBatches } from '../worker/drain-queue.js';
import {
  finalizeProjectProjection,
  type FinalizeProjectionResult,
} from '../worker/finalize-projection.js';
import { fingerprintWorktree } from '../worker/git-worktree.js';
import {
  KnowledgeWorker,
  type WorkerProject,
} from '../worker/knowledge-worker.js';
import { acquireSingletonLock } from '../worker/singleton-lock.js';
import { synchronizeProjectWorktrees } from '../worker/worktree-lifecycle.js';

interface ProjectSyncActionsOptions {
  projectName?: string;
  embedder?: EmbeddingProvider;
  embeddingModel: {
    name: string;
    revision: string;
    dimensions: number;
  };
}

interface QueueSummary {
  pending: number;
  failed: number;
}

interface ProjectionSummary {
  total: number;
  current: number;
  drifted: number;
  stale: number;
  pending: number;
  other: number;
}

interface RunProjectSyncActionResult {
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
  source?: unknown;
  knowledge?: unknown;
  embeddings?: number;
}

function defaultVaultPath(projectKey: string): string {
  return path.resolve('G:\\My Drive\\.obsidian', projectKey);
}

function queueSummary(status: ProjectSyncStatus): QueueSummary {
  return {
    pending: status.summary?.pendingJobs ?? status.queues.pending,
    failed: status.summary?.failedJobs ?? status.queues.failed,
  };
}

function projectionState(row: unknown): string | undefined {
  if (!row || typeof row !== 'object' || !('state' in row)) return undefined;
  const state = (row as { state?: unknown }).state;
  return typeof state === 'string' ? state : undefined;
}

function projectionPath(row: unknown): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const relativePath = (row as { relative_path?: unknown }).relative_path;
  if (typeof relativePath === 'string') return relativePath;
  const projectionPath = (row as { path?: unknown }).path;
  return typeof projectionPath === 'string' ? projectionPath : undefined;
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

function baseResult(
  state: RunProjectSyncActionResult['state'],
  before: ProjectSyncStatus,
  after: ProjectSyncStatus,
  input: ProjectSyncActionInput,
  executedActions: SyncSuggestedAction['action'][] = [],
  deferredActions: SyncSuggestedAction[] = [],
  reason?: string,
): RunProjectSyncActionResult {
  return {
    projectKey: input.projectKey,
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
    timeoutMs: input.timeoutSeconds * 1000,
  };
}

function matchingActions(
  status: ProjectSyncStatus,
  input: ProjectSyncActionInput,
): SyncSuggestedAction[] {
  const actions = (status.topSuggestedActions ?? []).filter(
    (action) => action.action === input.action,
  );
  if (!input.actionId) return actions;
  return actions.filter((action) => action.actionId === input.actionId);
}

export class ProjectSyncActionsService implements ProjectSyncActionRunner {
  private readonly store: PgKnowledgeStore;

  constructor(
    private readonly pool: Pool,
    private readonly options: ProjectSyncActionsOptions,
  ) {
    this.store = new PgKnowledgeStore(pool as unknown as PgPoolLike);
  }

  async finalizeProjection(
    input: FinalizeProjectionInput,
  ): Promise<FinalizeProjectionResult> {
    return this.withWorkerLock(async () => {
      const project = this.project(input);
      const worker = this.worker(input.localEmbeddingFallback);
      return finalizeProjectProjection(
        {
          getStatus: () => this.status(input.projectKey),
          processEmbeddings: () =>
            input.localEmbeddingFallback && this.options.embedder
              ? drainQueueBatches((limit) => worker.processEmbeddings(limit), 50)
              : Promise.resolve(0),
          publishVault: () => worker.publishVault(project),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        },
        {
          projectKey: input.projectKey,
          timeoutMs: input.timeoutSeconds * 1000,
          pollMs: input.pollSeconds * 1000,
        },
      );
    });
  }

  async runProjectSyncAction(
    input: ProjectSyncActionInput,
  ): Promise<RunProjectSyncActionResult | FinalizeProjectionResult> {
    if (input.action === 'FINALIZE_PROJECTION') {
      return this.finalizeProjection(input);
    }

    return this.withWorkerLock(async () => {
      const before = await this.status(input.projectKey);
      if (queueSummary(before).failed > 0)
        return baseResult(
          'blocked',
          before,
          before,
          input,
          [],
          before.topSuggestedActions ?? [],
          'failed-jobs',
        );

      const actions = matchingActions(before, input);
      if ((before.topSuggestedActions ?? []).length > 0 && actions.length === 0)
        return baseResult(
          'blocked',
          before,
          before,
          input,
          [],
          before.topSuggestedActions ?? [],
          'action-not-suggested',
        );

      const project = this.project(input);
      const initial = await fingerprintWorktree(project.repositoryPath);
      const worker = this.worker(input.localEmbeddingFallback);
      const source = await synchronizeProjectWorktrees(worker, project, {
        targetPaths: [project.repositoryPath],
      });
      const documents = await worker.syncCanonicalDocuments(project);
      const structured = await worker.syncStructuredDocumentation(project);
      const embeddings =
        input.localEmbeddingFallback && this.options.embedder
          ? await drainQueueBatches(
              (limit) => worker.processEmbeddings(limit),
              50,
            )
          : 0;
      await worker.publishVault(project);
      const final = await fingerprintWorktree(project.repositoryPath);
      if (initial.head !== final.head || initial.dirtyHash !== final.dirtyHash)
        throw new Error(
          'Source changed during synchronization; no matching completion receipt was issued',
        );
      const after = await this.status(input.projectKey);
      return {
        ...baseResult(
          'completed',
          before,
          after,
          input,
          ['REINDEX_SOURCE', 'FINALIZE_PROJECTION'],
          (after.topSuggestedActions ?? []).filter(
            (action) =>
              action.action !== 'REINDEX_SOURCE' &&
              action.action !== 'FINALIZE_PROJECTION',
          ),
        ),
        source,
        knowledge: { documents, structured },
        embeddings,
      };
    });
  }

  private async status(projectKey: string): Promise<ProjectSyncStatus> {
    return this.store.getProjectSyncStatus({
      projectKey,
      changedOnly: false,
      compact: true,
      issueLimit: 10,
      actionLimit: 10,
    });
  }

  private project(input: {
    projectKey: string;
    worktreePath: string;
    vaultPath?: string;
  }): WorkerProject {
    return {
      projectKey: input.projectKey,
      name: this.options.projectName ?? input.projectKey,
      repositoryPath: path.resolve(input.worktreePath),
      vaultPath: path.resolve(
        input.vaultPath ?? defaultVaultPath(input.projectKey),
      ),
    };
  }

  private worker(localEmbeddingFallback: boolean): KnowledgeWorker {
    return new KnowledgeWorker(
      this.pool,
      localEmbeddingFallback ? this.options.embedder : undefined,
      this.options.embeddingModel,
    );
  }

  private async withWorkerLock<T>(operation: () => Promise<T>): Promise<T> {
    const singleton = await acquireSingletonLock(
      this.pool,
      'obsidian-local-project-knowledge-worker',
    );
    if (!singleton.acquired)
      throw new Error('The local project knowledge worker is already running');
    try {
      return await operation();
    } finally {
      await singleton.release();
    }
  }
}
