import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { loadProjectKnowledgeEnvironment } from './config/registry.js';
import { getRuntimeConfig } from './knowledge/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadProjectKnowledgeEnvironment(root);
const runtime = getRuntimeConfig({ ...process.env, OBSIDIAN_MCP_PROFILE: 'standard' });
if (!runtime.databaseUrl) throw new Error('PROJECT_KNOWLEDGE_DATABASE_URL is required');
const projectKey = process.env.PROJECT_KNOWLEDGE_PROJECT_KEY?.trim() || 'MC-Platform';
const expectedRelease = process.env.PROJECT_KNOWLEDGE_EXPECTED_QUEUE_RELEASE?.trim();
const pool = new Pool({ connectionString: runtime.databaseUrl, max: 1, statement_timeout: 5000 });
try {
  const row = (
    await pool.query<{
      release_id: string | null;
      heartbeat_at: string;
      pending_count: number;
      failed_count: number;
      age_seconds: number;
    }>(
      `SELECT health.release_id,health.heartbeat_at,health.pending_count,health.failed_count,
              extract(epoch FROM now()-health.heartbeat_at) AS age_seconds
       FROM project_knowledge.worker_health health
       JOIN project_knowledge.projects project ON project.project_id=health.project_id
       WHERE project.project_key=$1 AND health.worker_role='embedding-queue'`,
      [projectKey],
    )
  ).rows[0];
  if (!row || Number(row.age_seconds) > 30 || (expectedRelease && row.release_id !== expectedRelease))
    throw new Error('Queue worker heartbeat is missing, stale, or from a different release');
  console.log(JSON.stringify({ state: 'healthy', projectKey, ...row }));
} finally {
  await pool.end();
}
