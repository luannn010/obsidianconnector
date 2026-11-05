import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import path from 'node:path';
import {
  applyKnowledgeMigrations,
  PgKnowledgeStore,
} from '../../src/knowledge/pg-store.js';
import { knowledgeMigrations } from '../../src/knowledge/migrations.js';
import { countSerializedTokens } from '../../src/knowledge/token-budget.js';

const databaseUrl = process.env.PROJECT_KNOWLEDGE_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('PostgreSQL knowledge retrieval', () => {
  let pool: Pool;
  let store: PgKnowledgeStore;
  let snapshotId = '';
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    if (process.env.OBSIDIAN_TEST_SEED_LEGACY_FIXTURE === '1') {
      if (!new URL(databaseUrl!).pathname.startsWith('/obsidian_test_')) {
        throw new Error(
          'Legacy fixture seeding requires an isolated obsidian_test_ database',
        );
      }
      await applyKnowledgeMigrations(pool, knowledgeMigrations);
      const projectId = (
        await pool.query<{ project_id: string }>(
          "INSERT INTO project_knowledge.projects(project_key,name) VALUES('MC-Platform','Isolated test fixture') RETURNING project_id",
        )
      ).rows[0]!.project_id;
      const repositoryId = (
        await pool.query<{ id: string }>(
          "INSERT INTO project_knowledge.repositories(project_id,name,root_path) VALUES($1,'fixture','/fixture') RETURNING id",
          [projectId],
        )
      ).rows[0]!.id;
      const worktreeId = (
        await pool.query<{ id: string }>(
          'INSERT INTO project_knowledge.worktrees(project_id,repository_id,path,head_commit) VALUES($1,$2,$3,$4) RETURNING id',
          [
            projectId,
            repositoryId,
            path.resolve('C:\\Users\\luann\\Documents\\MC-Platform'),
            'fixture-head',
          ],
        )
      ).rows[0]!.id;
      const sourceId = (
        await pool.query<{ id: string }>(
          "INSERT INTO project_knowledge.source_snapshots(project_id,worktree_id,head_commit,state,activated_at) VALUES($1,$2,'fixture-head','active',now()) RETURNING id",
          [projectId, worktreeId],
        )
      ).rows[0]!.id;
      await pool.query(
        `INSERT INTO project_knowledge.search_chunks(project_id,snapshot_id,worktree_id,kind,title,content,content_hash,token_count,metadata)
         VALUES($1,$2,$3,'documentation','package.json','{"name":"fixture"}','package-fixture',10,'{"path":"package.json"}'::jsonb),
               ($1,$2,$3,'documentation','Allocation','allocation ownership lifecycle is managed by the fixture service','allocation-fixture',15,'{"path":"docs/allocation.md"}'::jsonb)`,
        [projectId, sourceId, worktreeId],
      );
    }
    store = new PgKnowledgeStore(pool);
    snapshotId = (
      await pool.query<{
        id: string;
      }>(`SELECT s.id FROM project_knowledge.source_snapshots s
      JOIN project_knowledge.projects p ON p.project_id=s.project_id WHERE p.project_key='MC-Platform' AND s.state='active' LIMIT 1`)
    ).rows[0]!.id;
  }, 30000);
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
