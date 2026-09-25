import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  getConfigPath,
  loadProjectKnowledgeEnvironment,
  VaultRegistry,
} from './config/registry.js';
import { createServer } from './server.js';
import { getRuntimeConfig } from './knowledge/config.js';
import {
  HttpCrossEncoderReranker,
  OpenAiCompatibleEmbeddingClient,
} from './knowledge/embedding-client.js';
import { createPgKnowledgeStore } from './knowledge/pg-store.js';
import { ProjectSyncActionsService } from './services/project-sync-actions-service.js';

export async function main(): Promise<void> {
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  loadProjectKnowledgeEnvironment(projectRoot);
  const registry = await VaultRegistry.load(
    getConfigPath({ cwd: projectRoot }),
  );
  const runtime = getRuntimeConfig();
  const embedder = runtime.embeddingBaseUrl
    ? new OpenAiCompatibleEmbeddingClient(
        runtime.embeddingBaseUrl,
        runtime.embeddingModel,
        runtime.embeddingDimensions,
        runtime.embeddingToken,
      )
    : undefined;
  const database = runtime.databaseUrl
    ? createPgKnowledgeStore(
        runtime.databaseUrl,
        runtime.poolMax,
        runtime.statementTimeoutMs,
        {
          ...(embedder ? { embedder } : {}),
          ...(runtime.rerankerEnabled && runtime.rerankerBaseUrl
            ? {
                reranker: new HttpCrossEncoderReranker(
                  runtime.rerankerBaseUrl,
                  runtime.rerankerModel,
                  runtime.rerankerToken,
                ),
              }
            : {}),
          rerankerEnabled: runtime.rerankerEnabled,
        },
      )
    : undefined;
  const server = createServer(registry, {
    profile: runtime.profile,
    ...(database
      ? {
          knowledge: database.store,
          syncActions: new ProjectSyncActionsService(database.pool, {
            projectName: process.env.PROJECT_KNOWLEDGE_PROJECT_NAME?.trim(),
            ...(embedder ? { embedder } : {}),
            embeddingModel: {
              name: runtime.embeddingModel,
              revision: runtime.embeddingRevision,
              dimensions: runtime.embeddingDimensions,
            },
          }),
        }
      : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
