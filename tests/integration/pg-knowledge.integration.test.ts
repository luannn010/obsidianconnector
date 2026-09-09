import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PgKnowledgeStore } from '../../src/knowledge/pg-store.js';
import { countSerializedTokens } from '../../src/knowledge/token-budget.js';

const databaseUrl = process.env.PROJECT_KNOWLEDGE_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('PostgreSQL knowledge retrieval', () => {
  let pool: Pool;
  let store: PgKnowledgeStore;
  let snapshotId = '';
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    store = new PgKnowledgeStore(pool);
    snapshotId = (
      await pool.query<{
        id: string;
      }>(`SELECT s.id FROM project_knowledge.source_snapshots s
      JOIN project_knowledge.projects p ON p.project_id=s.project_id WHERE p.project_key='MC-Platform' AND s.state='active' LIMIT 1`)
    ).rows[0]!.id;
  });
  afterAll(async () => pool?.end());

  it('returns an exact path without scanning the repository', async () => {
    const result = await store.searchProjectContext({
      projectKey: 'MC-Platform',
      snapshotId,
      query: 'package.json',
      mode: 'exact',
      limit: 6,
      maxTokens: 1600,
    });
    expect(result.results[0]?.path).toBe('package.json');
    expect(result.budget.used).toBeLessThanOrEqual(1600);
  });

  it('packs the complete snapshot envelope under its budget', async () => {
    const result = await store.getProjectSnapshot({
      projectKey: 'MC-Platform',
      worktreePath: 'C:\\Users\\luann\\Documents\\MC-Platform',
      maxTokens: 800,
    });
    expect(countSerializedTokens(result)).toBeLessThanOrEqual(800);
    expect(result.budget.used).toBe(countSerializedTokens(result));
  });

  it('returns bounded BM25 conceptual results', async () => {
    const result = await store.searchProjectContext({
      projectKey: 'MC-Platform',
      snapshotId,
      query: 'allocation ownership lifecycle',
      mode: 'hybrid',
      limit: 6,
      maxTokens: 1600,
    });
    expect(result.results.length).toBeGreaterThan(0);
    expect(countSerializedTokens(result)).toBeLessThanOrEqual(1600);
  });
});
