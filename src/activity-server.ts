import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { loadDotEnv } from './config/registry.js';
import { getRuntimeConfig } from './knowledge/config.js';
import { createActivityHttpServer } from './activity/http-server.js';
import { PgActivityHandler } from './activity/pg-activity-handler.js';
import { drainActivitySpool } from './activity/spool.js';

loadDotEnv();
loadDotEnv(path.join(os.homedir(), '.codex', 'project-knowledge.env'));

const runtime = getRuntimeConfig({
  ...process.env,
  OBSIDIAN_MCP_PROFILE: 'admin',
  PROJECT_KNOWLEDGE_ACTIVITY_ENABLED: 'true',
});
if (!runtime.databaseUrl || !runtime.activityToken)
  throw new Error('Database URL and activity token are required');

const pool = new Pool({
  connectionString: runtime.databaseUrl,
  max: Math.min(runtime.poolMax, 2),
  statement_timeout: runtime.statementTimeoutMs,
  application_name: 'obsidian-local-activity',
});
const handler = new PgActivityHandler(pool);
const spoolPath =
  runtime.activitySpoolPath ??
  path.join(
    os.homedir(),
    '.codex',
    'project-knowledge',
    'activity-spool.ndjson',
  );

async function replaySpool(): Promise<void> {
  const result = await drainActivitySpool(spoolPath, (entry) =>
    handler.record(entry).then(() => undefined),
  );
  if (result.replayed || result.retained || result.invalid)
    console.error(
      JSON.stringify({ event: 'activity_spool_replay', ...result }),
    );
}

const server = createActivityHttpServer({
  token: runtime.activityToken,
  handler,
});
server.listen(runtime.activityPort, runtime.activityHost, () => {
  console.error(
    JSON.stringify({
      event: 'activity_daemon_ready',
      host: runtime.activityHost,
      port: runtime.activityPort,
    }),
  );
});

await replaySpool();
const replayTimer = setInterval(
  () => void replaySpool().catch((error) => console.error(error)),
  5_000,
);
const retentionTimer = setInterval(
  () =>
    void pool
      .query(
        `DELETE FROM project_knowledge.file_activity_events
         WHERE occurred_at < now() - interval '90 days'`,
      )
      .catch((error) => console.error(error)),
  24 * 60 * 60 * 1_000,
);

async function stop(): Promise<void> {
  clearInterval(replayTimer);
  clearInterval(retentionTimer);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await pool.end();
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
