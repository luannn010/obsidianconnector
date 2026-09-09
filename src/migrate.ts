import { Pool } from 'pg';
import { loadDotEnv } from './config/registry.js';
import { getRuntimeConfig } from './knowledge/config.js';
import { knowledgeMigrations } from './knowledge/migrations.js';
import {
  applyKnowledgeMigrations,
  type PgPoolLike,
} from './knowledge/pg-store.js';

loadDotEnv();
const config = getRuntimeConfig({
  ...process.env,
  OBSIDIAN_MCP_PROFILE: 'admin',
});
if (!config.migrationDatabaseUrl)
  throw new Error('PROJECT_KNOWLEDGE_MIGRATION_DATABASE_URL is required');
const pool = new Pool({
  connectionString: config.migrationDatabaseUrl,
  max: 1,
  statement_timeout: 30_000,
});
try {
  await applyKnowledgeMigrations(
    pool as unknown as PgPoolLike,
    knowledgeMigrations,
  );
  console.log(
    `Applied ${knowledgeMigrations.length} project knowledge migration(s)`,
  );
} finally {
  await pool.end();
}
