import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { loadProjectKnowledgeEnvironment } from './config/registry.js';
import { getRuntimeConfig } from './knowledge/config.js';
import { OpenAiCompatibleEmbeddingClient } from './knowledge/embedding-client.js';
import { PgKnowledgeStore } from './knowledge/pg-store.js';
import { fingerprintWorktree } from './worker/git-worktree.js';
import { KnowledgeWorker, type WorkerProject } from './worker/knowledge-worker.js';
import { acquireSingletonLock } from './worker/singleton-lock.js';
import { synchronizeProjectWorktrees } from './worker/worktree-lifecycle.js';

const connectorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadProjectKnowledgeEnvironment(connectorRoot);
const runtime = getRuntimeConfig({ ...process.env, OBSIDIAN_MCP_PROFILE: 'standard' });
if (!runtime.databaseUrl) throw new Error('PROJECT_KNOWLEDGE_DATABASE_URL is required');
const project: WorkerProject = {
  projectKey: process.env.PROJECT_KNOWLEDGE_PROJECT_KEY?.trim() || 'MC-Platform',
  name: process.env.PROJECT_KNOWLEDGE_PROJECT_NAME?.trim() || 'MC-Platform',
  repositoryPath: path.resolve(process.env.PROJECT_KNOWLEDGE_REPOSITORY_PATH?.trim() || 'C:\\Users\\luann\\Documents\\MC-Platform'),
  vaultPath: path.resolve(process.env.PROJECT_KNOWLEDGE_VAULT_PATH?.trim() || 'G:\\My Drive\\.obsidian\\MC-Platform'),
};
const pool = new Pool({
  connectionString: runtime.databaseUrl,
  max: runtime.poolMax,
  statement_timeout: runtime.statementTimeoutMs,
  application_name: 'project-knowledge-local-sync',
});
const singleton = await acquireSingletonLock(pool, 'obsidian-local-project-knowledge-worker');
if (!singleton.acquired) throw new Error('The local project knowledge worker is already running');

const initial = await fingerprintWorktree(project.repositoryPath);
const projectRow = (
  await pool.query<{ project_id: string }>(
    `INSERT INTO project_knowledge.projects(project_key,name) VALUES($1,$2)
     ON CONFLICT(project_key) DO UPDATE SET name=EXCLUDED.name,updated_at=now() RETURNING project_id`,
    [project.projectKey, project.name],
  )
).rows[0]!;
const run = (
  await pool.query<{ id: string }>(
    `INSERT INTO project_knowledge.sync_runs(project_id,status,summary)
     VALUES($1,'running',$2::jsonb) RETURNING id`,
    [projectRow.project_id, JSON.stringify({ requestedFingerprint: initial })],
  )
).rows[0]!;

try {
  const allowLocalEmbeddings = process.env.PROJECT_KNOWLEDGE_PROCESS_EMBEDDINGS === 'true';
  const embedder = allowLocalEmbeddings && runtime.embeddingBaseUrl
    ? new OpenAiCompatibleEmbeddingClient(runtime.embeddingBaseUrl, runtime.embeddingModel, runtime.embeddingDimensions, runtime.embeddingToken)
    : undefined;
  const worker = new KnowledgeWorker(pool, embedder, {
    name: runtime.embeddingModel,
    revision: runtime.embeddingRevision,
    dimensions: runtime.embeddingDimensions,
  });
  const source = await synchronizeProjectWorktrees(worker, project, { targetPaths: [project.repositoryPath] });
  const documents = await worker.syncCanonicalDocuments(project);
  const structured = await worker.syncStructuredDocumentation(project);
  const inbox = await worker.processInbox(project);
  const embeddings = allowLocalEmbeddings ? await worker.processEmbeddings(50) : 0;
  const projections = await worker.publishVault(project);
  const final = await fingerprintWorktree(project.repositoryPath);
  if (initial.head !== final.head || initial.dirtyHash !== final.dirtyHash)
    throw new Error('Source changed during synchronization; no matching completion receipt was issued');
  const status = await new PgKnowledgeStore(pool as never).getProjectSyncStatus({
    projectKey: project.projectKey,
    changedOnly: false,
    compact: true,
    issueLimit: 10,
    actionLimit: 10,
  });
  const summary = { fingerprint: final, source, embeddings, knowledge: { documents, structured, inbox }, projections, status };
  await pool.query(
    `UPDATE project_knowledge.sync_runs SET status='completed',finished_at=now(),summary=$2::jsonb WHERE id=$1`,
    [run.id, JSON.stringify(summary)],
  );
  console.log(JSON.stringify({ syncRunId: run.id, state: 'completed', ...summary }, null, 2));
} catch (error) {
  await pool.query(
    `UPDATE project_knowledge.sync_runs SET status='failed',finished_at=now(),summary=summary||$2::jsonb WHERE id=$1`,
    [run.id, JSON.stringify({ error: error instanceof Error ? error.message : String(error) })],
  );
  throw error;
} finally {
  await singleton.release();
  await pool.end();
}
