import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { loadProjectKnowledgeEnvironment } from './config/registry.js';
import { getRuntimeConfig } from './knowledge/config.js';
import { OpenAiCompatibleEmbeddingClient } from './knowledge/embedding-client.js';
import { PgKnowledgeStore } from './knowledge/pg-store.js';
import {
  finalizeProjectProjection,
  type FinalizeProjectionOptions,
} from './worker/finalize-projection.js';
import { drainQueueBatches } from './worker/drain-queue.js';
import {
  KnowledgeWorker,
  type WorkerProject,
} from './worker/knowledge-worker.js';
import { acquireSingletonLock } from './worker/singleton-lock.js';

interface CliOptions {
  projectKey: string;
  worktreePath: string;
  vaultPath?: string;
  timeoutSeconds: number;
  pollSeconds: number;
  localEmbeddingFallback: boolean;
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`Missing value for ${name}`);
  return value;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`Expected a positive integer, received: ${value}`);
  return parsed;
}

function parseCliOptions(args: string[]): CliOptions {
  const projectKey = readOption(args, '--project-key')?.trim();
  const worktreePath = readOption(args, '--worktree-path')?.trim();
  if (!projectKey) throw new Error('--project-key is required');
  if (!worktreePath) throw new Error('--worktree-path is required');
  return {
    projectKey,
    worktreePath,
    vaultPath: readOption(args, '--vault-path')?.trim() || undefined,
    timeoutSeconds: positiveInteger(readOption(args, '--timeout-seconds'), 300),
    pollSeconds: positiveInteger(readOption(args, '--poll-seconds'), 5),
    localEmbeddingFallback: hasFlag(args, '--local-embedding-fallback'),
  };
}

async function main(): Promise<void> {
  const cli = parseCliOptions(process.argv.slice(2));
  const connectorRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  loadProjectKnowledgeEnvironment(connectorRoot);
  const runtime = getRuntimeConfig({
    ...process.env,
    OBSIDIAN_MCP_PROFILE: 'standard',
  });
  if (!runtime.databaseUrl)
    throw new Error('PROJECT_KNOWLEDGE_DATABASE_URL is required');

  const project: WorkerProject = {
    projectKey: cli.projectKey,
    name: process.env.PROJECT_KNOWLEDGE_PROJECT_NAME?.trim() || cli.projectKey,
    repositoryPath: path.resolve(cli.worktreePath),
    vaultPath: path.resolve(
      cli.vaultPath ||
        process.env.PROJECT_KNOWLEDGE_VAULT_PATH?.trim() ||
        path.join('G:\\My Drive\\.obsidian', cli.projectKey),
    ),
  };
  const options: FinalizeProjectionOptions = {
    projectKey: cli.projectKey,
    timeoutMs: cli.timeoutSeconds * 1000,
    pollMs: cli.pollSeconds * 1000,
  };

  const pool = new Pool({
    connectionString: runtime.databaseUrl,
    max: runtime.poolMax,
    statement_timeout: runtime.statementTimeoutMs,
    application_name: 'project-knowledge-finalize-projection',
  });
  const singleton = await acquireSingletonLock(
    pool,
    'obsidian-local-project-knowledge-worker',
  );
  if (!singleton.acquired)
    throw new Error('The local project knowledge worker is already running');

  try {
    const embedder =
      cli.localEmbeddingFallback && runtime.embeddingBaseUrl
        ? new OpenAiCompatibleEmbeddingClient(
            runtime.embeddingBaseUrl,
            runtime.embeddingModel,
            runtime.embeddingDimensions,
            runtime.embeddingToken,
          )
        : undefined;
    const worker = new KnowledgeWorker(pool, embedder, {
      name: runtime.embeddingModel,
      revision: runtime.embeddingRevision,
      dimensions: runtime.embeddingDimensions,
    });
    const store = new PgKnowledgeStore(pool as never);
    const result = await finalizeProjectProjection(
      {
        getStatus: () =>
          store.getProjectSyncStatus({
            projectKey: cli.projectKey,
            changedOnly: false,
            compact: true,
            issueLimit: 10,
            actionLimit: 10,
          }),
        processEmbeddings: () =>
          cli.localEmbeddingFallback
            ? drainQueueBatches((limit) => worker.processEmbeddings(limit), 50)
            : Promise.resolve(0),
        publishVault: () => worker.publishVault(project),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      options,
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.state === 'blocked' || result.state === 'timeout')
      process.exitCode = 1;
  } finally {
    await singleton.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
