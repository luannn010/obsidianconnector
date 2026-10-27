import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { loadProjectKnowledgeEnvironment } from './config/registry.js';
import { getRuntimeConfig } from './knowledge/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadProjectKnowledgeEnvironment(root);
const runtime = getRuntimeConfig({ ...process.env, OBSIDIAN_MCP_PROFILE: 'standard' });
if (!runtime.databaseUrl) throw new Error('PROJECT_KNOWLEDGE_DATABASE_URL is required');
const expectedRelease = process.env.PROJECT_KNOWLEDGE_EXPECTED_QUEUE_RELEASE?.trim();
const expectedHostKind = process.env.PROJECT_KNOWLEDGE_EXPECTED_HOST_KIND?.trim() || 'debian';
const pool = new Pool({ connectionString: runtime.databaseUrl, max: 1, statement_timeout: 5000 });
try {
  const row = (
    await pool.query<{
      worker_id: string;
      release_id: string | null;
      heartbeat_at: string;
      age_seconds: number;
    }>(
      `SELECT worker_id,release_id,heartbeat_at,
              extract(epoch FROM now()-heartbeat_at) AS age_seconds
       FROM project_knowledge.worker_instances
       WHERE host_kind=$1 AND capabilities@>ARRAY['embedding']::text[]
       ORDER BY heartbeat_at DESC LIMIT 1`,
      [expectedHostKind],
    )
  ).rows[0];
  if (!row || Number(row.age_seconds) > 30 || (expectedRelease && row.release_id !== expectedRelease))
    throw new Error('Queue worker heartbeat is missing, stale, or from a different release');
  const counts = (await pool.query<{ pending: number; failed: number }>(
    `SELECT count(*) FILTER(WHERE state IN ('pending','processing')) AS pending,
            count(*) FILTER(WHERE state IN ('failed','dead')) AS failed
     FROM project_knowledge.outbox_jobs WHERE required_capability='embedding'`,
  )).rows[0];
  console.log(JSON.stringify({ state: 'healthy', hostKind: expectedHostKind, ...row, ...counts }));
} finally {
  await pool.end();
}
