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
    expect(getRuntimeConfig()).toMatchObject({ profile: 'admin', poolMax: 4 });
  });
});
