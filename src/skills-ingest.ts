import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { loadProjectKnowledgeEnvironment } from './config/registry.js';
import { getRuntimeConfig } from './knowledge/config.js';
import { PgKnowledgeStore } from './knowledge/pg-store.js';
import {
  buildSkillKnowledgeItems,
  planSkillChanges,
  prepareSkillChangeBatches,
  readSkillRepository,
  SkillIngestValidationError,
  type ExistingSkillKnowledgeItem,
  type SkillIngestSummary,
} from './skills/skill-ingest.js';

interface CliOptions {
  repositoryPath: string;
  projectKey: string;
  dryRun: boolean;
}

interface ExistingItemRow {
  id: string;
  stable_key: string;
  kind: 'other:skill' | 'other:skill-reference';
  current_version: number;
  delivery_status: string | null;
  superseded_by: string | null;
  properties: Record<string, unknown> | null;
}

interface CliSummary extends SkillIngestSummary {
  gitCommit: string;
}

function parseArguments(args: string[]): CliOptions {
  let repositoryPath: string | undefined;
  let projectKey = 'agent-skills';
  let dryRun = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--repo') {
      repositoryPath = args[++index];
      if (!repositoryPath) throw new Error('--repo requires a path');
    } else if (argument === '--project-key') {
      projectKey = args[++index]?.trim() ?? '';
      if (!projectKey) throw new Error('--project-key requires a value');
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!repositoryPath) throw new Error('--repo is required');
  return {
    repositoryPath: path.resolve(repositoryPath),
    projectKey,
    dryRun,
  };
}

function gitHead(repositoryPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: repositoryPath, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Unable to read Git HEAD for ${repositoryPath}: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function ensureProject(pool: Pool, projectKey: string): Promise<number> {
  const result = await pool.query<{ db_revision: number }>(
    `INSERT INTO project_knowledge.projects(project_key,name) VALUES($1,$2)
     ON CONFLICT(project_key) DO UPDATE SET name=EXCLUDED.name,updated_at=now()
     RETURNING db_revision`,
    [projectKey, 'Agent Skills'],
  );
  return Number(result.rows[0]!.db_revision);
}

async function existingItems(
  pool: Pool,
  projectKey: string,
): Promise<ExistingSkillKnowledgeItem[]> {
  const result = await pool.query<ExistingItemRow>(
    `SELECT i.id,i.stable_key,i.kind,i.current_version,i.delivery_status,
            i.superseded_by,v.properties
       FROM project_knowledge.projects p
       JOIN project_knowledge.knowledge_items i ON i.project_id=p.project_id
       JOIN project_knowledge.knowledge_versions v
         ON v.item_id=i.id AND v.version=i.current_version
      WHERE p.project_key=$1
        AND i.kind IN ('other:skill','other:skill-reference')
      ORDER BY i.stable_key`,
    [projectKey],
  );
  return result.rows.map((row) => ({
    id: row.id,
    stableKey: row.stable_key,
    kind: row.kind,
    currentVersion: Number(row.current_version),
    contentHash:
      typeof row.properties?.contentHash === 'string'
        ? row.properties.contentHash
        : undefined,
    deliveryStatus: row.delivery_status,
    supersededBy: row.superseded_by,
  }));
}

async function main(): Promise<void> {
  const connectorRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  loadProjectKnowledgeEnvironment(connectorRoot);
  const runtime = getRuntimeConfig({
    ...process.env,
    OBSIDIAN_MCP_PROFILE: 'standard',
  });
  if (!runtime.databaseUrl)
    throw new Error('PROJECT_KNOWLEDGE_DATABASE_URL is required');

  const options = parseArguments(process.argv.slice(2));
  const [gitCommit, repositoryFiles] = await Promise.all([
    gitHead(options.repositoryPath),
    readSkillRepository(options.repositoryPath),
  ]);
  const candidates = buildSkillKnowledgeItems(repositoryFiles, gitCommit);
  const pool = new Pool({
    connectionString: runtime.databaseUrl,
    max: runtime.poolMax,
    statement_timeout: runtime.statementTimeoutMs,
    application_name: 'project-knowledge-skills-ingest',
  });

  try {
    const currentItems = await existingItems(pool, options.projectKey);
    const plan = planSkillChanges(candidates, currentItems);
    const batches = prepareSkillChangeBatches(plan.changes);
    const summary: CliSummary = { ...plan.summary, gitCommit };

    if (!options.dryRun) {
      let revision = await ensureProject(pool, options.projectKey);
      const store = new PgKnowledgeStore(pool as never);
      for (const [batchIndex, batch] of batches.entries()) {
        const result = await store.writeProjectKnowledge({
          projectKey: options.projectKey,
          actor: 'skills-ingest',
          reason: 'evidence_refresh',
          message: `Ingest agent skills at ${gitCommit.slice(0, 12)} (batch ${batchIndex + 1}/${batches.length})`,
          idempotencyKey: `skills-ingest:${gitCommit}:${batchIndex}:${batch.hash}`,
          expectedProjectRevision: revision,
          changes: batch.changes,
        });
        revision = result.dbRevision;
      }
    }

    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof SkillIngestValidationError)
    for (const message of error.errors) process.stderr.write(`${message}\n`);
  else
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
  process.exitCode = 1;
}
