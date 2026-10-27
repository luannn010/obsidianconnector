import { Pool } from 'pg';
import { loadProjectKnowledgeEnvironment } from './config/registry.js';
import { getRuntimeConfig } from './knowledge/config.js';
import {
  defaultMaintenanceDependencies,
  runMaintenance,
  type MaintenanceOptions,
} from './worker/knowledge-maintenance.js';

function positiveInteger(name: string, value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseArgs(args: string[]): MaintenanceOptions {
  const options: MaintenanceOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--apply') options.apply = true;
    else if (argument === '--skip-vacuum') options.skipVacuum = true;
    else if (argument === '--retention-days')
      options.retentionDays = positiveInteger(argument, args[++index]);
    else if (argument === '--max-batches')
      options.maxBatches = positiveInteger(argument, args[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

loadProjectKnowledgeEnvironment(process.cwd());
const runtime = getRuntimeConfig({
  ...process.env,
  OBSIDIAN_MCP_PROFILE: 'standard',
});
if (!runtime.databaseUrl)
  throw new Error('PROJECT_KNOWLEDGE_DATABASE_URL is required');
const pool = new Pool({
  connectionString: runtime.databaseUrl,
  // runMaintenance holds one client while pruning checks out another.
  max: 2,
  application_name: 'project-knowledge-maintenance',
});

try {
  await runMaintenance(
    pool,
    parseArgs(process.argv.slice(2)),
    defaultMaintenanceDependencies(
      {
        name: runtime.embeddingModel,
        revision: runtime.embeddingRevision,
        dimensions: runtime.embeddingDimensions,
      },
      process.env.PROJECT_KNOWLEDGE_MIGRATION_DATABASE_URL?.trim() || undefined,
    ),
  );
} finally {
  await pool.end();
}
