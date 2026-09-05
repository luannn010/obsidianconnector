export interface RuntimeConfig {
  profile: 'standard' | 'admin';
  databaseUrl?: string;
  migrationDatabaseUrl?: string;
  poolMax: number;
  statementTimeoutMs: number;
  embeddingBaseUrl?: string;
  embeddingModel: string;
  embeddingDimensions: number;
  rerankerEnabled: boolean;
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
    embeddingBaseUrl:
      env.PROJECT_KNOWLEDGE_EMBEDDING_BASE_URL?.trim() || undefined,
    embeddingModel:
      env.PROJECT_KNOWLEDGE_EMBEDDING_MODEL?.trim() || 'bge-large-en-v1.5',
    embeddingDimensions: boundedInteger(
      env.PROJECT_KNOWLEDGE_EMBEDDING_DIMENSIONS,
      1024,
      1,
      4096,
    ),
    rerankerEnabled: env.PROJECT_KNOWLEDGE_RERANKER_ENABLED === 'true',
  };
}
