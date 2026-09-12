import type { Pool } from 'pg';
import { fingerprintWorktree } from './git-worktree.js';
import { KnowledgeWorker, type WorkerProject } from './knowledge-worker.js';
import type { SharedJob } from './shared-job-queue.js';
import {
  mapPortableRelativePathToContainer,
  mapWindowsPathToContainer,
} from './worker-path-mapper.js';

export interface SourceSyncResolution {
  syncRunId: string;
  fingerprint: { head: string; dirtyHash: string | null };
  snapshotId: string;
  snapshotState: 'created' | 'reused';
  indexedFiles: number;
  childJobs: { pending: number; failed: number };
  pendingCount: number;
  failures: number;
  projection: { current: number; drifted: number };
}

export class SourceSyncJobHandler {
  constructor(
    private readonly pool: Pool,
    private readonly projectsHostRoot: string,
    private readonly projectsContainerRoot: string,
    private readonly vaultsContainerRoot: string,
  ) {}

  async process(job: SharedJob): Promise<SourceSyncResolution> {
    const worktreeId = String(job.payload.worktreeId ?? '');
    if (!worktreeId) throw new Error('source_sync job is missing worktreeId');
    const target = (
      await this.pool.query<{
        project_key: string;
        name: string;
        vault_relative_path: string;
        worktree_path: string;
        repository_path: string;
      }>(
        `SELECT project.project_key,project.name,project.vault_relative_path,
                worktree.path AS worktree_path,
                repository.root_path AS repository_path
         FROM project_knowledge.worktrees worktree
         JOIN project_knowledge.projects project ON project.project_id=worktree.project_id
         JOIN project_knowledge.repositories repository ON repository.id=worktree.repository_id
         WHERE worktree.id=$1 AND worktree.project_id=$2 AND worktree.registered`,
        [worktreeId, job.project_id],
      )
    ).rows[0];
    if (!target) throw new Error('Registered source worktree was not found');
    const containerWorktree = mapWindowsPathToContainer(
      target.worktree_path,
      this.projectsHostRoot,
      this.projectsContainerRoot,
    );
    const project: WorkerProject = {
      projectKey: target.project_key,
      name: target.name,
      repositoryPath: containerWorktree,
      logicalRepositoryPath: target.worktree_path,
      vaultPath: mapPortableRelativePathToContainer(
        target.vault_relative_path || target.project_key,
        this.vaultsContainerRoot,
      ),
    };
    const initial = await fingerprintWorktree(containerWorktree);
    const run = (
      await this.pool.query<{ id: string }>(
        `INSERT INTO project_knowledge.sync_runs(project_id,status,summary)
       VALUES($1,'running',$2::jsonb) RETURNING id`,
        [
          job.project_id,
          JSON.stringify({
            parentJobId: job.id,
            requestedFingerprint: initial,
          }),
        ],
      )
    ).rows[0]!;
    try {
      const worker = new KnowledgeWorker(this.pool);
      const source = await worker.reconcile(project, {
        primaryRepositoryPath: target.repository_path,
        parentJobId: job.id,
      });
      await worker.syncCanonicalDocuments(project);
      await worker.syncStructuredDocumentation(project);
      await worker.processInbox(project);
      const projection = await worker.publishVault(project);
      const final = await fingerprintWorktree(containerWorktree);
      if (initial.head !== final.head || initial.dirtyHash !== final.dirtyHash)
        throw new Error('Source changed during synchronization');
      const childJobs = (
        await this.pool.query<{ pending: number; failed: number }>(
          `SELECT count(*) FILTER(WHERE state IN ('pending','processing')) AS pending,
                count(*) FILTER(WHERE state IN ('failed','dead')) AS failed
         FROM project_knowledge.outbox_jobs WHERE parent_job_id=$1`,
          [job.id],
        )
      ).rows[0] ?? { pending: 0, failed: 0 };
      const queue = (
        await this.pool.query<{ pending: number; failed: number }>(
          `SELECT count(*) FILTER(WHERE state IN ('pending','processing')) AS pending,
                count(*) FILTER(WHERE state IN ('failed','dead')) AS failed
         FROM project_knowledge.outbox_jobs WHERE project_id=$1`,
          [job.project_id],
        )
      ).rows[0] ?? { pending: 0, failed: 0 };
      const resolution: SourceSyncResolution = {
        syncRunId: run.id,
        fingerprint: { head: final.head, dirtyHash: final.dirtyHash },
        snapshotId: source.snapshotId,
        snapshotState: source.changed ? 'created' : 'reused',
        indexedFiles: source.indexedFiles,
        childJobs: {
          pending: Number(childJobs.pending ?? 0),
          failed: Number(childJobs.failed ?? 0),
        },
        pendingCount: Number(queue.pending ?? 0),
        failures: Number(queue.failed ?? 0),
        projection,
      };
      await this.pool.query(
        `UPDATE project_knowledge.sync_runs SET status='completed',finished_at=now(),summary=$2::jsonb WHERE id=$1`,
        [run.id, JSON.stringify(resolution)],
      );
      return resolution;
    } catch (error) {
      await this.pool.query(
        `UPDATE project_knowledge.sync_runs SET status='failed',finished_at=now(),summary=summary||$2::jsonb WHERE id=$1`,
        [
          run.id,
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        ],
      );
      throw error;
    }
  }
}
