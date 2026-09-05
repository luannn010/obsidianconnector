import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PgPoolLike } from '../knowledge/pg-store.js';
import { fingerprintWorktree } from '../worker/git-worktree.js';
import {
  shouldRecordActivityPath,
  type ActivityAgent,
  type NormalizedActivityEvent,
  type NormalizedHookPayload,
} from './hook-normalizer.js';
import type { ActivityRequestHandler } from './http-server.js';

export interface ActivityWorktreeFingerprint {
  root: string;
  branch: string;
  head: string;
  dirtyHash: string | null;
}

export interface ActivityWorktreeResolver {
  resolve(cwd: string): Promise<ActivityWorktreeFingerprint>;
}

const defaultResolver: ActivityWorktreeResolver = {
  resolve: async (cwd) => fingerprintWorktree(cwd),
};

function isAgent(value: unknown): value is ActivityAgent {
  return value === 'codex' || value === 'claude';
}

function eventKey(event: NormalizedActivityEvent): string {
  if (event.toolCallId)
    return `${event.turnId ?? 'turn'}:${event.toolCallId}:${event.action}`;
  return createHash('sha256')
    .update(
      JSON.stringify([
        event.action,
        event.path,
        event.captureMethod,
        event.confidence,
      ]),
    )
    .digest('hex');
}

function normalizedRelativePath(
  root: string,
  cwd: string,
  candidate: string,
): string | undefined {
  const absolute = path.resolve(cwd, candidate);
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    return undefined;
  const normalized = relative.replace(/\\/gu, '/');
  return shouldRecordActivityPath(normalized) ? normalized : undefined;
}

export class PgActivityHandler implements ActivityRequestHandler {
  constructor(
    private readonly pool: PgPoolLike,
    private readonly resolver: ActivityWorktreeResolver = defaultResolver,
  ) {}

  async record(
    payload: unknown,
  ): Promise<{ accepted: number; ignored: number }> {
    const input = payload as Partial<NormalizedHookPayload> & {
      projectKey?: string;
    };
    if (
      !isAgent(input.agent) ||
      typeof input.sessionId !== 'string' ||
      !input.sessionId.trim() ||
      typeof input.cwd !== 'string' ||
      !input.cwd.trim()
    )
      throw new Error('Invalid activity payload');
    const projectKey = input.projectKey?.trim() || 'MC-Platform';
    const fingerprint = await this.resolver.resolve(input.cwd);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const project = (
        await client.query<{ project_id: string }>(
          'SELECT project_id FROM project_knowledge.projects WHERE project_key=$1',
          [projectKey],
        )
      ).rows[0];
      if (!project) throw new Error('Project is not registered');
      const repository = (
        await client.query<{ id: string }>(
          `SELECT repository.id FROM project_knowledge.repositories repository
           WHERE repository.project_id=$1 AND
             (lower(repository.root_path)=lower($2) OR EXISTS (
               SELECT 1 FROM project_knowledge.worktrees registered
               WHERE registered.repository_id=repository.id AND registered.registered
                 AND lower(registered.path)=lower($2)
             ))
           ORDER BY repository.id LIMIT 1`,
          [project.project_id, path.resolve(fingerprint.root)],
        )
      ).rows[0];
      if (!repository)
        throw new Error('Activity path is outside configured repositories');
      const worktree = (
        await client.query<{ id: string }>(
          `INSERT INTO project_knowledge.worktrees
           (project_id,repository_id,path,branch,head_commit,dirty_hash,registered,last_seen_at)
           VALUES($1,$2,$3,$4,$5,$6,true,now())
           ON CONFLICT(project_id,path) DO UPDATE SET
             branch=EXCLUDED.branch,head_commit=EXCLUDED.head_commit,
             dirty_hash=EXCLUDED.dirty_hash,last_seen_at=now()
           RETURNING id`,
          [
            project.project_id,
            repository.id,
            path.resolve(fingerprint.root),
            fingerprint.branch,
            fingerprint.head,
            fingerprint.dirtyHash,
          ],
        )
      ).rows[0]!;
      const snapshot = (
        await client.query<{ id: string }>(
          `SELECT id FROM project_knowledge.source_snapshots
           WHERE project_id=$1 AND worktree_id=$2 AND state='active'
           ORDER BY activated_at DESC NULLS LAST LIMIT 1`,
          [project.project_id, worktree.id],
        )
      ).rows[0];
      const task = (
        await client.query<{ id: string }>(
          `INSERT INTO project_knowledge.agent_tasks
           (project_id,agent,external_task_id,task_name,worktree_id,start_snapshot_id,status,last_seen_at)
           VALUES($1,$2,$3,$4,$5,$6,'active',now())
           ON CONFLICT(project_id,agent,external_task_id) DO UPDATE SET
             task_name=CASE
               WHEN project_knowledge.agent_tasks.task_name='Untitled task'
                 AND EXCLUDED.task_name<>'Untitled task' THEN EXCLUDED.task_name
               ELSE project_knowledge.agent_tasks.task_name END,
             worktree_id=EXCLUDED.worktree_id,last_seen_at=now()
           RETURNING id`,
          [
            project.project_id,
            input.agent,
            input.sessionId,
            input.taskName?.trim().slice(0, 120) || 'Untitled task',
            worktree.id,
            snapshot?.id ?? null,
          ],
        )
      ).rows[0]!;
      if (input.lifecycle === 'session_start')
        await client.query(
          `UPDATE project_knowledge.agent_tasks SET status='active',ended_at=NULL,
           end_snapshot_id=NULL,last_seen_at=now() WHERE id=$1`,
          [task.id],
        );
      else if (input.lifecycle === 'session_end')
        await client.query(
          `UPDATE project_knowledge.agent_tasks SET status='completed',ended_at=now(),
           end_snapshot_id=$2,last_seen_at=now() WHERE id=$1`,
          [task.id, snapshot?.id ?? null],
        );

      let accepted = 0;
      let ignored = 0;
      for (const event of input.events ?? []) {
        const relative = normalizedRelativePath(
          fingerprint.root,
          input.cwd,
          event.path,
        );
        if (!relative) {
          ignored++;
          continue;
        }
        const source = snapshot
          ? (
              await client.query<{ source_hash: string }>(
                `SELECT source_hash FROM project_knowledge.code_files
                 WHERE snapshot_id=$1 AND repo_relative_path=$2 AND NOT deleted LIMIT 1`,
                [snapshot.id, relative],
              )
            ).rows[0]
          : undefined;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO project_knowledge.file_activity_events
           (project_id,task_id,worktree_id,snapshot_id,event_key,turn_id,tool_call_id,
            repo_relative_path,action,source_hash,capture_method,confidence)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            project.project_id,
            task.id,
            worktree.id,
            snapshot?.id ?? null,
            eventKey(event),
            event.turnId ?? null,
            event.toolCallId ?? null,
            relative,
            event.action,
            source?.source_hash ?? null,
            event.captureMethod,
            event.confidence,
          ],
        );
        if (!inserted.rows.length) continue;
        accepted++;
        await client.query(
          `INSERT INTO project_knowledge.task_file_rollups
           (project_id,task_id,worktree_id,repo_relative_path,actions,access_count,
            first_access_at,last_access_at,initial_source_hash,final_source_hash,changed_by_task)
           VALUES($1,$2,$3,$4,ARRAY[$5]::text[],1,now(),now(),$6,$6,$7)
           ON CONFLICT(task_id,repo_relative_path) DO UPDATE SET
             actions=(SELECT array_agg(DISTINCT action ORDER BY action)
                      FROM unnest(project_knowledge.task_file_rollups.actions || EXCLUDED.actions) action),
             access_count=project_knowledge.task_file_rollups.access_count+1,
             last_access_at=now(),final_source_hash=COALESCE(EXCLUDED.final_source_hash,project_knowledge.task_file_rollups.final_source_hash),
             changed_by_task=project_knowledge.task_file_rollups.changed_by_task OR EXCLUDED.changed_by_task`,
          [
            project.project_id,
            task.id,
            worktree.id,
            relative,
            event.action,
            source?.source_hash ?? null,
            ['create', 'edit', 'delete'].includes(event.action),
          ],
        );
      }
      await client.query('COMMIT');
      return { accepted, ignored };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async gate(input: {
    projectKey: string;
    agent: string;
    sessionId: string;
  }): Promise<{ blocked: boolean; refs: string[] }> {
    const result = await this.pool.query<{ ref: string }>(
      `SELECT DISTINCT 'knowledge:'||i.id||':v'||i.current_version AS ref
       FROM project_knowledge.projects p
       JOIN project_knowledge.agent_tasks t ON t.project_id=p.project_id
       JOIN project_knowledge.task_file_rollups f ON f.task_id=t.id AND f.changed_by_task
       JOIN project_knowledge.source_evidence e ON e.project_id=p.project_id
         AND e.source_path=f.repo_relative_path AND e.required
       JOIN project_knowledge.knowledge_items i ON i.id=e.item_id
       JOIN project_knowledge.source_snapshots active_snapshot
         ON active_snapshot.worktree_id=t.worktree_id AND active_snapshot.state='active'
       LEFT JOIN project_knowledge.documentation_freshness df
         ON df.item_id=e.item_id AND df.knowledge_version_id=e.knowledge_version_id
         AND df.worktree_id=t.worktree_id AND df.snapshot_id=active_snapshot.id
       WHERE p.project_key=$1 AND t.agent=$2 AND t.external_task_id=$3
         AND COALESCE(df.state,'unverified') <> 'current'
       ORDER BY ref LIMIT 20`,
      [input.projectKey, input.agent, input.sessionId],
    );
    return {
      blocked: result.rows.length > 0,
      refs: result.rows.map((row) => row.ref),
    };
  }
}
