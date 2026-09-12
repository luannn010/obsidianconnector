import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { loadProjectKnowledgeEnvironment } from './config/registry.js';
import { getRuntimeConfig } from './knowledge/config.js';
import { OpenAiCompatibleEmbeddingClient } from './knowledge/embedding-client.js';
import { EmbeddingQueueProcessor } from './worker/embedding-queue-processor.js';
import { HourlySourceScheduler } from './worker/job-scheduler.js';
import {
  SharedJobQueue,
  type WorkerCapability,
} from './worker/shared-job-queue.js';
import { SourceSyncJobHandler } from './worker/source-sync-job-handler.js';
import { acquireSingletonLock } from './worker/singleton-lock.js';
import { WorkerInstanceRegistry } from './worker/worker-instance-registry.js';
import { runMaintenanceCycle } from './worker/maintenance-cycle.js';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
loadProjectKnowledgeEnvironment(projectRoot);
const runtime = getRuntimeConfig({
  ...process.env,
  OBSIDIAN_MCP_PROFILE: 'standard',
});
if (!runtime.databaseUrl)
  throw new Error('Shared worker requires PROJECT_KNOWLEDGE_DATABASE_URL');

const allowed = new Set<WorkerCapability>([
  'source-sync',
  'publish',
  'embedding',
  'maintenance',
  'scheduler',
]);
const capabilities = (
  process.env.PROJECT_KNOWLEDGE_WORKER_CAPABILITIES ??
  'embedding,maintenance,scheduler'
)
  .split(',')
  .map((value) => value.trim())
  .filter((value): value is WorkerCapability =>
    allowed.has(value as WorkerCapability),
  );
if (capabilities.length === 0)
  throw new Error('Shared worker has no valid capabilities');
const hostKind =
  process.env.PROJECT_KNOWLEDGE_HOST_KIND === 'windows' ? 'windows' : 'debian';
const workerId =
  process.env.PROJECT_KNOWLEDGE_WORKER_ID?.trim() ||
  `${hostKind}-${os.hostname()}-${process.pid}`;
const releaseId = process.env.PROJECT_KNOWLEDGE_WORKER_RELEASE?.trim();
const batchSize = Math.min(
  64,
  Math.max(1, Number(process.env.PROJECT_KNOWLEDGE_QUEUE_BATCH_SIZE ?? 16)),
);
const pollMs = Math.min(
  60_000,
  Math.max(250, Number(process.env.PROJECT_KNOWLEDGE_QUEUE_POLL_MS ?? 1000)),
);
const idleExitSeconds = Math.max(
  0,
  Number(
    process.env.PROJECT_KNOWLEDGE_IDLE_EXIT_SECONDS ??
      (hostKind === 'windows' ? 60 : 0),
  ),
);
const sourceWorktreeId =
  process.env.PROJECT_KNOWLEDGE_SOURCE_WORKTREE_ID?.trim();
const retentionDays = Math.min(
  365,
  Math.max(
    1,
    Number(process.env.PROJECT_KNOWLEDGE_SNAPSHOT_RETENTION_DAYS ?? 7),
  ),
);
const pool = new Pool({
  connectionString: runtime.databaseUrl,
  max: Math.min(runtime.poolMax, 4),
  statement_timeout: Math.max(runtime.statementTimeoutMs, 30_000),
  application_name: `project-knowledge-${hostKind}-worker`,
});
const queue = new SharedJobQueue(pool);
const registry = new WorkerInstanceRegistry(
  pool,
  workerId,
  hostKind,
  capabilities,
  releaseId,
);
const sourceHandler = capabilities.includes('source-sync')
  ? new SourceSyncJobHandler(
      pool,
      process.env.PROJECT_KNOWLEDGE_PROJECTS_HOST_ROOT ??
        'C:\\Users\\luann\\Documents',
      process.env.PROJECT_KNOWLEDGE_PROJECTS_CONTAINER_ROOT ?? '/projects',
      process.env.PROJECT_KNOWLEDGE_VAULTS_CONTAINER_ROOT ?? '/vaults',
    )
  : undefined;
let embedder: EmbeddingQueueProcessor | undefined;
if (capabilities.includes('embedding')) {
  if (!runtime.embeddingBaseUrl || !runtime.embeddingToken)
    throw new Error('Embedding capability requires embedding URL and token');
  embedder = new EmbeddingQueueProcessor(
    pool,
    new OpenAiCompatibleEmbeddingClient(
      runtime.embeddingBaseUrl,
      runtime.embeddingModel,
      runtime.embeddingDimensions,
      runtime.embeddingToken,
    ),
    {
      name: runtime.embeddingModel,
      revision: runtime.embeddingRevision,
      dimensions: runtime.embeddingDimensions,
    },
    workerId,
  );
}

let stopping = false;
let idleSince = Date.now();
let nextMaintenance = 0;
process.once('SIGINT', () => {
  stopping = true;
});
process.once('SIGTERM', () => {
  stopping = true;
});
const heartbeat = setInterval(() => {
  void registry.heartbeat().catch(() => undefined);
}, 15_000);
heartbeat.unref();
await registry.heartbeat();

let schedulerLock: Awaited<ReturnType<typeof acquireSingletonLock>> | undefined;
if (capabilities.includes('scheduler'))
  schedulerLock = await acquireSingletonLock(
    pool,
    'project-knowledge-shared-worker-scheduler',
  );
const scheduler = schedulerLock?.acquired
  ? new HourlySourceScheduler(pool, queue)
  : undefined;

try {
  while (!stopping) {
    let work = 0;
    let currentJobId: string | undefined;
    try {
      if (scheduler) work += await scheduler.runIfDue(workerId);
      if (
        capabilities.includes('maintenance') &&
        Date.now() >= nextMaintenance
      ) {
        nextMaintenance = Date.now() + 24 * 60 * 60 * 1000;
        work += await runMaintenanceCycle(
          pool,
          queue,
          retentionDays,
          (error) => {
            console.error(
              JSON.stringify({
                event: 'maintenance_error',
                workerId,
                message: error instanceof Error ? error.message : String(error),
              }),
            );
          },
        );
      }
      if (sourceHandler) {
        const [job] = await queue.claim(['source-sync'], workerId, 1, 120, {
          sourceWorktreeId,
        });
        if (job) {
          currentJobId = job.id;
          await registry.heartbeat(job.id);
          const renewal = setInterval(() => {
            void queue.renew(job.id, workerId).catch(() => undefined);
          }, 15_000);
          renewal.unref();
          try {
            const resolution = await sourceHandler.process(job);
            await queue.complete(job.id, workerId, resolution);
            work += 1;
          } catch (error) {
            await queue.fail(job, workerId, error);
            await registry.heartbeat(job.id, {
              failed: 1,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            clearInterval(renewal);
          }
        }
      }
      const mayEmbed =
        Boolean(embedder) &&
        (hostKind === 'debian' ||
          !(await registry.hasFreshDebianEmbeddingWorker()));
      if (embedder && mayEmbed) {
        const stats = await embedder.processBatch(batchSize);
        work += stats.claimed + stats.retired + stats.reused + stats.completed;
        await registry.heartbeat(currentJobId, {
          processed: stats.applied,
          failed: stats.failed,
        });
      } else {
        await registry.heartbeat(currentJobId);
      }
    } catch (error) {
      await registry
        .heartbeat(currentJobId, {
          failed: 1,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      console.error(
        JSON.stringify({
          event: 'worker_error',
          workerId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    if (work > 0) idleSince = Date.now();
    if (idleExitSeconds > 0 && Date.now() - idleSince >= idleExitSeconds * 1000)
      break;
    if (work === 0) await delay(pollMs);
  }
} finally {
  clearInterval(heartbeat);
  await schedulerLock?.release();
  await pool.end();
}
