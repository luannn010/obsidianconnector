import { afterEach, describe, expect, it } from 'vitest';
import { getRuntimeConfig } from '../../src/knowledge/config.js';

afterEach(() => {
  for (const key of [
    'OBSIDIAN_MCP_PROFILE',
    'PROJECT_KNOWLEDGE_DATABASE_URL',
    'PROJECT_KNOWLEDGE_DB_POOL_MAX',
  ])
    delete process.env[key];
});

describe('knowledge runtime configuration', () => {
  it('requires a database URL for the standard profile and bounds the pool', () => {
    process.env.OBSIDIAN_MCP_PROFILE = 'standard';
    expect(() => getRuntimeConfig()).toThrow('PROJECT_KNOWLEDGE_DATABASE_URL');
    process.env.PROJECT_KNOWLEDGE_DATABASE_URL =
      'postgresql://localhost/playnode';
    process.env.PROJECT_KNOWLEDGE_DB_POOL_MAX = '99';
    expect(getRuntimeConfig()).toMatchObject({
      profile: 'standard',
      poolMax: 8,
    });
  });

  it('defaults to the admin profile for backward compatibility', () => {
    expect(getRuntimeConfig()).toMatchObject({
      profile: 'admin',
      poolMax: 4,
      embeddingModel: 'BAAI/bge-small-en-v1.5',
      embeddingDimensions: 384,
      rerankerModel: 'cross-encoder/ms-marco-MiniLM-L-6-v2',
    });
  });

  it('loads authenticated embedding and reranker endpoints independently', () => {
    const config = getRuntimeConfig({
      OBSIDIAN_MCP_PROFILE: 'standard',
      PROJECT_KNOWLEDGE_DATABASE_URL: 'postgresql://localhost/playnode',
      PROJECT_KNOWLEDGE_EMBEDDING_BASE_URL: 'http://embedding.local:8080',
      PROJECT_KNOWLEDGE_EMBEDDING_TOKEN: 'embedding-secret',
      PROJECT_KNOWLEDGE_RERANKER_ENABLED: 'true',
      PROJECT_KNOWLEDGE_RERANKER_BASE_URL: 'http://reranker.local:8081',
      PROJECT_KNOWLEDGE_RERANKER_MODEL: 'BAAI/custom-reranker',
      PROJECT_KNOWLEDGE_RERANKER_TOKEN: 'reranker-secret',
    });

    expect(config).toMatchObject({
      embeddingBaseUrl: 'http://embedding.local:8080',
      embeddingToken: 'embedding-secret',
      rerankerEnabled: true,
      rerankerBaseUrl: 'http://reranker.local:8081',
      rerankerModel: 'BAAI/custom-reranker',
      rerankerToken: 'reranker-secret',
    });
  });

  it('rejects an embedding endpoint without a bearer token', () => {
    expect(() =>
      getRuntimeConfig({
        OBSIDIAN_MCP_PROFILE: 'standard',
        PROJECT_KNOWLEDGE_DATABASE_URL: 'postgresql://localhost/playnode',
        PROJECT_KNOWLEDGE_EMBEDDING_BASE_URL: 'http://embedding.local:8080',
      }),
    ).toThrow('PROJECT_KNOWLEDGE_EMBEDDING_TOKEN');
  });

  it('rejects an enabled reranker without an authenticated endpoint', () => {
    expect(() =>
      getRuntimeConfig({
        OBSIDIAN_MCP_PROFILE: 'standard',
        PROJECT_KNOWLEDGE_DATABASE_URL: 'postgresql://localhost/playnode',
        PROJECT_KNOWLEDGE_RERANKER_ENABLED: 'true',
      }),
    ).toThrow('PROJECT_KNOWLEDGE_RERANKER_BASE_URL');
  });
});
