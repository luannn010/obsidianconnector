import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { loadProjectKnowledgeEnvironment } from './config/registry.js';
import { getRuntimeConfig } from './knowledge/config.js';
import { OpenAiCompatibleEmbeddingClient } from './knowledge/embedding-client.js';
import { EmbeddingQueueProcessor } from './worker/embedding-queue-processor.js';
import { QueueWorkerService } from './worker/queue-worker-service.js';
import { pruneSupersededSnapshots } from './worker/snapshot-cleanup.js';
import { acquireSingletonLock } from './worker/singleton-lock.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadProjectKnowledgeEnvironment(projectRoot);
const runtime = getRuntimeConfig({ ...process.env, OBSIDIAN_MCP_PROFILE: 'standard' });
if (!runtime.databaseUrl || !runtime.embeddingBaseUrl || !runtime.embeddingToken)
  throw new Error('Queue worker requires database, embedding URL, and embedding token');

const projectKey = process.env.PROJECT_KNOWLEDGE_PROJECT_KEY?.trim() || 'MC-Platform';
const batchSize = Math.min(500, Math.max(1, Number(process.env.PROJECT_KNOWLEDGE_QUEUE_BATCH_SIZE ?? 50)));
const pollMs = Math.min(60_000, Math.max(250, Number(process.env.PROJECT_KNOWLEDGE_QUEUE_POLL_MS ?? 1000)));
const retentionDays = Math.min(365, Math.max(1, Number(process.env.PROJECT_KNOWLEDGE_SNAPSHOT_RETENTION_DAYS ?? 7)));
const pool = new Pool({
  connectionString: runtime.databaseUrl,
  max: runtime.poolMax,
  statement_timeout: runtime.statementTimeoutMs,
  application_name: 'project-knowledge-queue-worker',
});
const singleton = await acquireSingletonLock(pool, 'obsidian-local-embedding-queue-worker');
if (!singleton.acquired) {
  console.error(JSON.stringify({ event: 'queue_worker_already_running', projectKey }));
  await pool.end();
  process.exit(0);
}

const embedder = new OpenAiCompatibleEmbeddingClient(
  runtime.embeddingBaseUrl,
  runtime.embeddingModel,
  runtime.embeddingDimensions,
  runtime.embeddingToken,
);
const processor = new EmbeddingQueueProcessor(pool, embedder, {
  name: runtime.embeddingModel,
  revision: runtime.embeddingRevision,
  dimensions: runtime.embeddingDimensions,
});
const service = new QueueWorkerService(pool, processor, {
  projectKey,
  releaseId: process.env.PROJECT_KNOWLEDGE_QUEUE_RELEASE?.trim(),
});

let stopping = false;
const runOnce = process.env.PROJECT_KNOWLEDGE_QUEUE_ONCE === 'true';
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });
let nextCleanup = 0;
try {
  while (!stopping) {
    try {
      const stats = await service.runOnce(batchSize);
      const now = Date.now();
      if (now >= nextCleanup) {
        const cleanup = await pruneSupersededSnapshots(pool, projectKey, retentionDays);
        console.error(JSON.stringify({ event: 'snapshot_cleanup', projectKey, ...cleanup }));
        nextCleanup = now + 24 * 60 * 60 * 1000;
      }
      if (stats.claimed + stats.retired + stats.reused + stats.completed === 0)
        await delay(pollMs);
      if (runOnce) stopping = true;
    } catch (error) {
      await service.recordError(error).catch(() => undefined);
      console.error(JSON.stringify({
        event: 'queue_worker_error',
        message: error instanceof Error ? error.message : String(error),
      }));
      await delay(Math.min(30_000, pollMs * 5));
    }
  }
} finally {
  await singleton.release();
  await pool.end();
}
