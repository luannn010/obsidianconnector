import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { loadProjectKnowledgeEnvironment } from './config/registry.js';
import { getRuntimeConfig } from './knowledge/config.js';
import { SharedJobQueue } from './worker/shared-job-queue.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadProjectKnowledgeEnvironment(root);
const runtime = getRuntimeConfig({ ...process.env, OBSIDIAN_MCP_PROFILE: 'standard' });
if (!runtime.databaseUrl) throw new Error('PROJECT_KNOWLEDGE_DATABASE_URL is required');
const pool = new Pool({ connectionString: runtime.databaseUrl, max: 1, application_name: 'project-knowledge-request' });
const queue = new SharedJobQueue(pool);
const args = process.argv.slice(2);
const valueAfter = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

try {
  if (args.includes('--enqueue')) {
    const projectKey = valueAfter('--project-key');
    const worktreePath = valueAfter('--worktree-path');
    if (!projectKey || !worktreePath) throw new Error('--project-key and --worktree-path are required');
    const target = (await pool.query<{ project_id: string; worktree_id: string }>(
      `SELECT project.project_id,worktree.id AS worktree_id
       FROM project_knowledge.projects project JOIN project_knowledge.worktrees worktree ON worktree.project_id=project.project_id
       WHERE project.project_key=$1 AND lower(worktree.path)=lower($2) AND worktree.registered LIMIT 1`,
      [projectKey, path.resolve(worktreePath)],
    )).rows[0];
    if (!target) throw new Error('The project worktree is not registered');
    const result = await queue.enqueueSourceSync(target.project_id, target.worktree_id, 'on_demand');
    console.log(JSON.stringify(result));
  } else if (args.includes('--wait')) {
    const jobId = valueAfter('--wait');
    if (!jobId) throw new Error('--wait requires a job ID');
    const timeoutSeconds = Math.max(30, Number(valueAfter('--timeout-seconds') ?? 1800));
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const job = await queue.find(jobId);
      if (!job) throw new Error('Source synchronization job was not found');
      if (job.state === 'done') {
        console.log(JSON.stringify({ jobId, state: job.state, assignedWorker: job.lease_owner ?? null, ...job.resolution }));
        process.exitCode = 0;
        break;
      }
      if (['dead', 'superseded'].includes(job.state)) throw new Error(job.last_error ?? `Job ended as ${job.state}`);
      await delay(1000);
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for source synchronization');
  } else {
    throw new Error('Use --enqueue or --wait <job-id>');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
