import path from 'node:path';
import { Pool } from 'pg';
import { watch } from 'chokidar';
import { loadDotEnv } from './config/registry.js';
import { getRuntimeConfig } from './knowledge/config.js';
import { OpenAiCompatibleEmbeddingClient } from './knowledge/embedding-client.js';
import { KnowledgeError } from './knowledge/errors.js';
import { PgKnowledgeStore } from './knowledge/pg-store.js';
import {
  KnowledgeWorker,
  type WorkerProject,
} from './worker/knowledge-worker.js';
import { drainQueueBatches } from './worker/drain-queue.js';
import { acquireSingletonLock } from './worker/singleton-lock.js';
import { runStatusFirstSync } from './worker/status-first-sync.js';
import { synchronizeProjectWorktrees } from './worker/worktree-lifecycle.js';

loadDotEnv();
const runtime = getRuntimeConfig({
  ...process.env,
  OBSIDIAN_MCP_PROFILE: 'admin',
});
if (!runtime.databaseUrl)
  throw new Error('PROJECT_KNOWLEDGE_DATABASE_URL is required');
const project: WorkerProject = {
  projectKey:
    process.env.PROJECT_KNOWLEDGE_PROJECT_KEY?.trim() || 'MC-Platform',
  name: process.env.PROJECT_KNOWLEDGE_PROJECT_NAME?.trim() || 'MC-Platform',
  repositoryPath: path.resolve(
    process.env.PROJECT_KNOWLEDGE_REPOSITORY_PATH?.trim() ||
      'C:\\Users\\luann\\Documents\\MC-Platform',
  ),
  vaultPath: path.resolve(
    process.env.PROJECT_KNOWLEDGE_VAULT_PATH?.trim() ||
      'G:\\My Drive\\.obsidian\\MC-Platform',
  ),
};
const pool = new Pool({
  connectionString: runtime.databaseUrl,
  max: runtime.poolMax,
  statement_timeout: runtime.statementTimeoutMs,
  application_name: 'obsidian-local-worker',
});
const singleton = await acquireSingletonLock(
  pool,
  'obsidian-local-project-knowledge-worker',
);
if (!singleton.acquired) {
  console.error(JSON.stringify({ event: 'knowledge_worker_already_running' }));
  await pool.end();
  process.exit(0);
}
const embedder = runtime.embeddingBaseUrl
  ? new OpenAiCompatibleEmbeddingClient(
      runtime.embeddingBaseUrl,
      runtime.embeddingModel,
      runtime.embeddingDimensions,
      runtime.embeddingToken,
    )
  : undefined;
const worker = new KnowledgeWorker(pool, embedder, {
  name: runtime.embeddingModel,
  revision: 'local',
  dimensions: runtime.embeddingDimensions,
});
const statusStore = new PgKnowledgeStore(pool as never);

let running: Promise<void> | undefined;
let rerun = false;
let sourceRefreshRequested = true;
let maintenanceRequested = true;

async function bootstrap(): Promise<Record<string, unknown>> {
  const worktrees = await synchronizeProjectWorktrees(worker, project);
  const legacy = await worker.importLegacy(project);
  const delivery = await worker.normalizeLegacyDelivery(project);
  const documents = await worker.syncCanonicalDocuments(project);
  const structured = await worker.syncStructuredDocumentation(project);
  const inbox = await worker.processInbox(project);
  const embeddings = await drainQueueBatches(
    () => worker.processEmbeddings(),
    50,
  );
  const projections = await worker.publishVault(project);
  return {
    mode: 'bootstrap',
    worktrees,
    legacy,
    delivery,
    documents,
    structured,
    inbox,
    embeddings,
    projections,
  };
}

async function synchronize(): Promise<void> {
  if (running) {
    rerun = true;
    return running;
  }
  running = (async () => {
    do {
      rerun = false;
      const forceReindex = sourceRefreshRequested;
      const runMaintenance = maintenanceRequested;
      sourceRefreshRequested = false;
      maintenanceRequested = false;
      const cycle: Record<string, unknown> = {};
      let knowledgeChanged = false;
      let projectionFinalized = false;
      try {
        const plan = await runStatusFirstSync(
          {
            getStatus: () =>
              statusStore.getProjectSyncStatus({
                projectKey: project.projectKey,
                changedOnly: true,
                compact: true,
                issueLimit: 10,
                actionLimit: 10,
              }),
            reindexSource: async (actions) => {
              const targetPaths = [
                ...new Set(
                  actions
                    .map((action) => action.worktreePath)
                    .filter((worktreePath): worktreePath is string =>
                      Boolean(worktreePath),
                    ),
                ),
              ];
              const worktrees = await synchronizeProjectWorktrees(
                worker,
                project,
                {
                  targetPaths:
                    targetPaths.length > 0
                      ? targetPaths
                      : [project.repositoryPath],
                },
              );
              cycle.worktrees = worktrees;
              if (worktrees.indexedWorktrees.some((entry) => entry.changed))
                rerun = true;
            },
            updateKnowledge: async () => {
              cycle.documents = await worker.syncCanonicalDocuments(project);
              cycle.structured =
                await worker.syncStructuredDocumentation(project);
              knowledgeChanged = true;
            },
            verifyEvidence: async () => {
              if (cycle.documents === undefined)
                cycle.documents = await worker.syncCanonicalDocuments(project);
              knowledgeChanged = true;
            },
            finalizeProjection: async () => {
              cycle.embeddings = await drainQueueBatches(
                () => worker.processEmbeddings(),
                50,
              );
              cycle.projections = await worker.publishVault(project);
              projectionFinalized = true;
            },
          },
          {
            mode: 'deep',
            forceReindex,
            allowFailedJobs:
              process.env.PROJECT_KNOWLEDGE_ALLOW_FAILED_REPAIR === 'true',
          },
        );
        cycle.plan = plan;

        if (plan.state !== 'blocked' && runMaintenance) {
          cycle.legacy = await worker.importLegacy(project);
          cycle.delivery = await worker.normalizeLegacyDelivery(project);
          cycle.inbox = await worker.processInbox(project);
          knowledgeChanged =
            knowledgeChanged ||
            Number(cycle.delivery ?? 0) > 0 ||
            Number(cycle.inbox ?? 0) > 0;
        }

        if (
          plan.state !== 'blocked' &&
          knowledgeChanged &&
          !projectionFinalized
        ) {
          cycle.embeddings = await drainQueueBatches(
            () => worker.processEmbeddings(),
            50,
          );
          cycle.projections = await worker.publishVault(project);
        }
      } catch (error) {
        if (!(error instanceof KnowledgeError) || error.code !== 'INDEX_STALE')
          throw error;
        Object.assign(cycle, await bootstrap());
      }
      console.error(
        JSON.stringify({
          event: 'knowledge_sync',
          ...cycle,
        }),
      );
    } while (rerun);
  })().finally(() => {
    running = undefined;
  });
  return running;
}

await synchronize();
if (process.env.PROJECT_KNOWLEDGE_WORKER_ONCE === 'true') {
  await singleton.release();
  await pool.end();
} else {
  const watcher = watch(
    [project.repositoryPath, path.join(project.vaultPath, 'Inbox')],
    {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      ignored:
        /(?:^|[/\\])(?:\.git|node_modules|dist|build|Archive|Published)(?:[/\\]|$)/u,
    },
  );
  let timer: NodeJS.Timeout | undefined;
  const repositoryRoot = `${path.resolve(project.repositoryPath).toLowerCase()}${path.sep}`;
  const inboxRoot = `${path.resolve(project.vaultPath, 'Inbox').toLowerCase()}${path.sep}`;
  const schedule = (changedPath: string) => {
    const absolutePath = path.resolve(changedPath).toLowerCase();
    if (
      absolutePath === repositoryRoot.slice(0, -1) ||
      absolutePath.startsWith(repositoryRoot)
    )
      sourceRefreshRequested = true;
    if (
      absolutePath === inboxRoot.slice(0, -1) ||
      absolutePath.startsWith(inboxRoot)
    )
      maintenanceRequested = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => void synchronize().catch((error) => console.error(error)),
      500,
    );
  };
  watcher.on('add', schedule).on('change', schedule).on('unlink', schedule);
  const interval = setInterval(
    () => void synchronize().catch((error) => console.error(error)),
    30_000,
  );
  const stop = async () => {
    clearInterval(interval);
    if (timer) clearTimeout(timer);
    await watcher.close();
    await running;
    await singleton.release();
    await pool.end();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}
