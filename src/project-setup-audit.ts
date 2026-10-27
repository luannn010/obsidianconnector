import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { loadProjectKnowledgeEnvironment } from './config/registry.js';
import { PgKnowledgeStore } from './knowledge/pg-store.js';
import { summarizeProjectSetupAudit } from './setup/project-setup-audit.js';

interface AuditArguments {
  projectKey: string;
  worktreePath: string;
  expectedSnapshotId: string;
  expectedWorktreeId: string;
}

let databaseConnected = false;

function parseArguments(args: string[]): AuditArguments {
  const valueAfter = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const parsed = {
    projectKey: valueAfter('--project-key'),
    worktreePath: valueAfter('--worktree-path'),
    expectedSnapshotId: valueAfter('--expected-snapshot-id'),
    expectedWorktreeId: valueAfter('--expected-worktree-id'),
  };
  const missing = Object.entries(parsed)
    .filter(([, value]) => !value || value.startsWith('--'))
    .map(([name]) => name);
  if (missing.length > 0)
    throw new Error(`Missing required audit arguments: ${missing.join(', ')}`);
  return parsed as AuditArguments;
}

async function main(): Promise<void> {
  const connectorRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  loadProjectKnowledgeEnvironment(connectorRoot);
  const databaseUrl = process.env.PROJECT_KNOWLEDGE_DATABASE_URL?.trim();
  if (!databaseUrl)
    throw new Error('PROJECT_KNOWLEDGE_DATABASE_URL is required');
  const args = parseArguments(process.argv.slice(2));
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: 'project-setup-audit',
  });
  try {
    await pool.query('SELECT 1');
    databaseConnected = true;
    const store = new PgKnowledgeStore(pool);
    const [snapshot, status] = await Promise.all([
      store.getProjectSnapshot({
        projectKey: args.projectKey,
        worktreePath: args.worktreePath,
        maxTokens: 800,
      }),
      store.getProjectSyncStatus({
        projectKey: args.projectKey,
        worktreeIds: [args.expectedWorktreeId],
        changedOnly: true,
        compact: true,
        issueLimit: 8,
        actionLimit: 8,
      }),
    ]);
    console.log(
      JSON.stringify(
        summarizeProjectSetupAudit({
          snapshot,
          status,
          expectedSnapshotId: args.expectedSnapshotId,
          expectedWorktreeId: args.expectedWorktreeId,
        }),
      ),
    );
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  const databaseUrl = process.env.PROJECT_KNOWLEDGE_DATABASE_URL;
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      state: 'failed',
      checks: { databaseConnected, snapshotReadable: false },
      error: databaseUrl
        ? message.replaceAll(databaseUrl, '<redacted database connection>')
        : message,
    }),
  );
  process.exitCode = 1;
}
