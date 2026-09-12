export interface RuntimeConfig {
  profile: 'standard' | 'admin';
  databaseUrl?: string;
  migrationDatabaseUrl?: string;
  poolMax: number;
  statementTimeoutMs: number;
  embeddingBaseUrl?: string;
  embeddingToken?: string;
  embeddingModel: string;
  embeddingRevision: string;
  embeddingDimensions: number;
  rerankerEnabled: boolean;
  rerankerBaseUrl?: string;
  rerankerModel: string;
  rerankerToken?: string;
  activityEnabled: boolean;
  activityHost: '127.0.0.1';
  activityPort: number;
  activityToken?: string;
  activitySpoolPath?: string;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

export function getRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const profile =
    env.OBSIDIAN_MCP_PROFILE === 'standard' ? 'standard' : 'admin';
  const databaseUrl = env.PROJECT_KNOWLEDGE_DATABASE_URL?.trim() || undefined;
  if (profile === 'standard' && !databaseUrl) {
    throw new Error(
      'PROJECT_KNOWLEDGE_DATABASE_URL is required for the standard profile',
    );
  }
  const embeddingBaseUrl =
    env.PROJECT_KNOWLEDGE_EMBEDDING_BASE_URL?.trim() || undefined;
  const embeddingToken =
    env.PROJECT_KNOWLEDGE_EMBEDDING_TOKEN?.trim() || undefined;
  if (embeddingBaseUrl && !embeddingToken)
    throw new Error(
      'PROJECT_KNOWLEDGE_EMBEDDING_TOKEN is required when the embedding endpoint is configured',
    );
  const rerankerEnabled = env.PROJECT_KNOWLEDGE_RERANKER_ENABLED === 'true';
  const rerankerBaseUrl =
    env.PROJECT_KNOWLEDGE_RERANKER_BASE_URL?.trim() || embeddingBaseUrl;
  const rerankerToken =
    env.PROJECT_KNOWLEDGE_RERANKER_TOKEN?.trim() || embeddingToken;
  if (rerankerEnabled && !rerankerBaseUrl)
    throw new Error(
      'PROJECT_KNOWLEDGE_RERANKER_BASE_URL is required when the reranker is enabled',
    );
  if (rerankerEnabled && !rerankerToken)
    throw new Error(
      'PROJECT_KNOWLEDGE_RERANKER_TOKEN is required when the reranker is enabled',
    );
  const activityEnabled = env.PROJECT_KNOWLEDGE_ACTIVITY_ENABLED === 'true';
  const activityToken =
    env.PROJECT_KNOWLEDGE_ACTIVITY_TOKEN?.trim() || undefined;
  const requestedActivityHost =
    env.PROJECT_KNOWLEDGE_ACTIVITY_HOST?.trim() || '127.0.0.1';
  if (requestedActivityHost !== '127.0.0.1')
    throw new Error('PROJECT_KNOWLEDGE_ACTIVITY_HOST must be 127.0.0.1');
  if (activityEnabled && !activityToken)
    throw new Error(
      'PROJECT_KNOWLEDGE_ACTIVITY_TOKEN is required when activity capture is enabled',
    );
  return {
    profile,
    databaseUrl,
    migrationDatabaseUrl:
      env.PROJECT_KNOWLEDGE_MIGRATION_DATABASE_URL?.trim() || databaseUrl,
    poolMax: boundedInteger(env.PROJECT_KNOWLEDGE_DB_POOL_MAX, 4, 1, 8),
    statementTimeoutMs: boundedInteger(
      env.PROJECT_KNOWLEDGE_STATEMENT_TIMEOUT_MS,
      5000,
      100,
      30_000,
    ),
    embeddingBaseUrl,
    embeddingToken,
    embeddingModel:
      env.PROJECT_KNOWLEDGE_EMBEDDING_MODEL?.trim() || 'BAAI/bge-small-en-v1.5',
    embeddingRevision:
      env.PROJECT_KNOWLEDGE_EMBEDDING_REVISION?.trim() || 'local',
    embeddingDimensions: boundedInteger(
      env.PROJECT_KNOWLEDGE_EMBEDDING_DIMENSIONS,
      384,
      1,
      4096,
    ),
    rerankerEnabled,
    rerankerBaseUrl,
    rerankerModel:
      env.PROJECT_KNOWLEDGE_RERANKER_MODEL?.trim() ||
      'cross-encoder/ms-marco-MiniLM-L-6-v2',
    rerankerToken,
    activityEnabled,
    activityHost: '127.0.0.1',
    activityPort: boundedInteger(
      env.PROJECT_KNOWLEDGE_ACTIVITY_PORT,
      8765,
      1024,
      65_535,
    ),
    activityToken,
    activitySpoolPath:
      env.PROJECT_KNOWLEDGE_ACTIVITY_SPOOL?.trim() || undefined,
  };
}
