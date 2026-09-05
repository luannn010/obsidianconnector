import path from 'node:path';
import { Pool } from 'pg';
import { watch } from 'chokidar';
import { loadDotEnv } from './config/registry.js';
import { getRuntimeConfig } from './knowledge/config.js';
import { OpenAiCompatibleEmbeddingClient } from './knowledge/embedding-client.js';
import {
  KnowledgeWorker,
  type WorkerProject,
} from './worker/knowledge-worker.js';

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
const embedder = runtime.embeddingBaseUrl
  ? new OpenAiCompatibleEmbeddingClient(
      runtime.embeddingBaseUrl,
      runtime.embeddingModel,
      runtime.embeddingDimensions,
    )
  : undefined;
const worker = new KnowledgeWorker(pool, embedder, {
  name: runtime.embeddingModel,
  revision: 'local',
  dimensions: runtime.embeddingDimensions,
});

let running: Promise<void> | undefined;
let rerun = false;
async function synchronize(): Promise<void> {
  if (running) {
    rerun = true;
    return running;
  }
  running = (async () => {
    do {
      rerun = false;
      const indexed = await worker.reconcile(project);
      const worktrees = await worker.syncWorktrees(project);
      const legacy = await worker.importLegacy(project);
      const delivery = await worker.normalizeLegacyDelivery(project);
      const documents = await worker.syncCanonicalDocuments(project);
      const structured = await worker.syncStructuredDocumentation(project);
      const inbox = await worker.processInbox(project);
      const embeddings = await worker.processEmbeddings();
      const projections = await worker.publishVault(project);
      console.error(
        JSON.stringify({
          event: 'knowledge_sync',
          indexed,
          worktrees,
          legacy,
          delivery,
          documents,
          structured,
          inbox,
          embeddings,
          projections,
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
  const schedule = () => {
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
    await pool.end();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}
