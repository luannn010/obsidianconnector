import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PgPoolLike } from '../knowledge/pg-store.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import { fingerprintWorktree } from '../worker/git-worktree.js';
import {
  shouldRecordActivityPath,
  type ActivityAgent,
  type NormalizedActivityEvent,
  type NormalizedHookPayload,
} from './hook-normalizer.js';
import type {
  ActivityHandoff,
  ActivityRequestHandler,
  ActivityStatus,
} from './http-server.js';

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

function isoString(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export class PgActivityHandler implements ActivityRequestHandler {
  constructor(
    private readonly pool: PgPoolLike,
    private readonly resolver: ActivityWorktreeResolver = defaultResolver,
    private readonly knowledge?: Pick<KnowledgeStore, 'writeProjectKnowledge'>,
  ) {}

  private readonly pendingHandoffs = new Set<Promise<void>>();

  async flushHandoffs(): Promise<void> {
    await Promise.all([...this.pendingHandoffs]);
  }

  private async writeHandoff(input: {
    projectId: string;
    projectKey: string;
    agent: ActivityAgent;
    sessionId: string;
    taskId: string;
  }): Promise<void> {
    if (!this.knowledge) return;
    const summary = (
      await this.pool.query<{
        task_name: string;
        status: string;
        branch: string | null;
        changed_files: string[] | null;
        changed_count: string | number;
        stale_refs: string[] | null;
      }>(
        `SELECT t.task_name, t.status, w.branch,
           changed.files AS changed_files, changed.total AS changed_count,
           stale.refs AS stale_refs
         FROM project_knowledge.agent_tasks t
         JOIN project_knowledge.worktrees w ON w.id=t.worktree_id
         LEFT JOIN LATERAL (
           SELECT (array_agg(f.repo_relative_path ORDER BY f.last_access_at DESC))[1:20] AS files,
                  count(*) AS total
           FROM project_knowledge.task_file_rollups f
           WHERE f.task_id=t.id AND f.changed_by_task
         ) changed ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(DISTINCT 'knowledge:'||i.id||':v'||i.current_version) AS refs
           FROM project_knowledge.task_file_rollups f
           JOIN project_knowledge.source_evidence e ON e.project_id=t.project_id
             AND e.source_path=f.repo_relative_path AND e.required
           JOIN project_knowledge.knowledge_items i ON i.id=e.item_id
           JOIN project_knowledge.source_snapshots active_snapshot
             ON active_snapshot.worktree_id=t.worktree_id AND active_snapshot.state='active'
           LEFT JOIN project_knowledge.documentation_freshness df
             ON df.item_id=e.item_id AND df.knowledge_version_id=e.knowledge_version_id
             AND df.worktree_id=t.worktree_id AND df.snapshot_id=active_snapshot.id
           WHERE f.task_id=t.id AND f.changed_by_task
             AND COALESCE(df.state,'unverified') <> 'current'
         ) stale ON true
         WHERE t.id=$1`,
        [input.taskId],
      )
    ).rows[0];
    const changedFiles = summary?.changed_files ?? [];
    if (!summary || !changedFiles.length) return;
    const moreFiles = Number(summary.changed_count) - changedFiles.length;
    const staleRefs = (summary.stale_refs ?? []).slice(0, 10);
    const bodyMarkdown = [
      `Agent: ${input.agent} · Session: ${input.sessionId} · Branch: ${summary.branch ?? 'unknown'} · Status: ${summary.status}`,
      '',
      '## Changed files',
      ...changedFiles.map((file) => `- ${file}`),
      ...(moreFiles > 0 ? [`- … and ${moreFiles} more`] : []),
      ...(staleRefs.length
        ? ['', '## Stale documentation', ...staleRefs.map((ref) => `- ${ref}`)]
        : []),
    ].join('\n');
    const stableKey = `handoff:${input.agent}:${input.sessionId}`;
    const existing = (
      await this.pool.query<{ id: string }>(
        `SELECT id FROM project_knowledge.knowledge_items
         WHERE project_id=$1 AND stable_key=$2`,
        [input.projectId, stableKey],
      )
    ).rows[0];
    const taskName =
      summary.task_name.replace(/<[^>]*>/gu, '').trim() || 'Untitled task';
    const title = `Handoff from ${input.agent}: ${taskName}`.slice(0, 160);
    const deliveryStatus =
      summary.status === 'completed' ? 'completed' : 'active';
    await this.knowledge.writeProjectKnowledge({
      projectKey: input.projectKey,
      actor: input.agent,
      taskId: input.sessionId,
      message: title,
      reason: 'progress',
      idempotencyKey: `${stableKey}:${createHash('sha256')
        .update(`${title}\n${deliveryStatus}\n${bodyMarkdown}`)
        .digest('hex')
        .slice(0, 16)}`,
      changes: [
        existing
          ? {
              operation: 'patch',
              item: { id: existing.id, title, bodyMarkdown, deliveryStatus },
            }
          : {
              operation: 'create',
              item: {
                kind: 'handoff',
                stableKey,
                title,
                bodyMarkdown,
                deliveryStatus,
              },
            },
      ],
    });
  }

  private async resolveProject(
    root: string,
    projectKey?: string,
  ): Promise<{ project_id: string; project_key: string } | undefined> {
    const configured = projectKey?.trim();
    if (configured)
      return (
        await this.pool.query<{ project_id: string; project_key: string }>(
          `SELECT project_id, project_key
           FROM project_knowledge.projects WHERE project_key=$1`,
          [configured],
        )
      ).rows[0];

    return (
      await this.pool.query<{ project_id: string; project_key: string }>(
        `SELECT project.project_id, project.project_key AS project_key
         FROM project_knowledge.projects project
         JOIN project_knowledge.repositories repository
           ON repository.project_id=project.project_id
         LEFT JOIN project_knowledge.worktrees worktree
           ON worktree.repository_id=repository.id AND worktree.registered
         WHERE lower(repository.root_path)=lower($1)
            OR lower(worktree.path)=lower($1)
         ORDER BY CASE WHEN lower(worktree.path)=lower($1) THEN 0 ELSE 1 END,
                  project.project_key
         LIMIT 1`,
        [path.resolve(root)],
      )
    ).rows[0];
  }

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
    const fingerprint = await this.resolver.resolve(input.cwd);
    const project = await this.resolveProject(
      fingerprint.root,
      input.projectKey,
    );
    if (!project) return { accepted: 0, ignored: (input.events ?? []).length };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
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
      if (
        input.lifecycle === 'session_end' ||
        (input.lifecycle === 'stop' && !input.stopHookActive)
      ) {
        const pending = this.writeHandoff({
          projectId: project.project_id,
          projectKey: input.projectKey?.trim() || project.project_key,
          agent: input.agent,
          sessionId: input.sessionId,
          taskId: task.id,
        })
          .catch((error: unknown) =>
            console.error(
              JSON.stringify({
                event: 'activity_handoff_failed',
                message: error instanceof Error ? error.message : String(error),
              }),
            ),
          )
          .finally(() => this.pendingHandoffs.delete(pending));
        this.pendingHandoffs.add(pending);
      }
      return { accepted, ignored };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async handoff(input: {
    projectKey?: string;
    agent: string;
    cwd: string;
  }): Promise<ActivityHandoff> {
    const fingerprint = await this.resolver.resolve(input.cwd);
    const projectKey = input.projectKey?.trim();
    const project = projectKey
      ? undefined
      : await this.resolveProject(fingerprint.root);
    const resolvedProjectKey = projectKey ?? project?.project_key;
    if (!resolvedProjectKey) return { tasks: [], blockers: [] };
    const otherAgent = input.agent === 'codex' ? 'claude' : 'codex';
    const tasks = await this.pool.query<{
      agent: ActivityAgent;
      task_name: string;
      status: string;
      last_seen_at: Date | string;
      branch: string | null;
      changed_files: string[] | null;
      changed_count: string | number;
      stale_refs: string[] | null;
    }>(
      `SELECT t.agent, t.task_name, t.status, t.last_seen_at, w.branch,
         changed.files AS changed_files, changed.total AS changed_count,
         stale.refs AS stale_refs
       FROM project_knowledge.projects p
       JOIN project_knowledge.agent_tasks t ON t.project_id=p.project_id
       JOIN project_knowledge.worktrees w ON w.id=t.worktree_id
       LEFT JOIN LATERAL (
         SELECT (array_agg(f.repo_relative_path ORDER BY f.last_access_at DESC))[1:8] AS files,
                count(*) AS total
         FROM project_knowledge.task_file_rollups f
         WHERE f.task_id=t.id AND f.changed_by_task
       ) changed ON true
       LEFT JOIN LATERAL (
         SELECT array_agg(DISTINCT 'knowledge:'||i.id||':v'||i.current_version) AS refs
         FROM project_knowledge.task_file_rollups f
         JOIN project_knowledge.source_evidence e ON e.project_id=p.project_id
           AND e.source_path=f.repo_relative_path AND e.required
         JOIN project_knowledge.knowledge_items i ON i.id=e.item_id
         JOIN project_knowledge.source_snapshots active_snapshot
           ON active_snapshot.worktree_id=t.worktree_id AND active_snapshot.state='active'
         LEFT JOIN project_knowledge.documentation_freshness df
           ON df.item_id=e.item_id AND df.knowledge_version_id=e.knowledge_version_id
           AND df.worktree_id=t.worktree_id AND df.snapshot_id=active_snapshot.id
         WHERE f.task_id=t.id AND f.changed_by_task
           AND COALESCE(df.state,'unverified') <> 'current'
       ) stale ON true
       WHERE p.project_key=$1 AND t.agent=$2 AND lower(w.path)=lower($3)
         AND t.last_seen_at > now() - interval '7 days'
         AND (t.status='active' OR changed.total > 0)
       ORDER BY t.last_seen_at DESC LIMIT 3`,
      [resolvedProjectKey, otherAgent, path.resolve(fingerprint.root)],
    );
    const blockers = await this.pool.query<{ title: string }>(
      `SELECT i.title FROM project_knowledge.knowledge_items i
       JOIN project_knowledge.projects p ON p.project_id=i.project_id
       WHERE p.project_key=$1 AND i.kind='blocker' AND i.superseded_by IS NULL
         AND COALESCE(i.delivery_status,'open') NOT IN ('completed','resolved','cancelled')
       ORDER BY i.updated_at DESC LIMIT 3`,
      [resolvedProjectKey],
    );
    return {
      tasks: tasks.rows.map((row) => {
        const changedFiles = row.changed_files ?? [];
        return {
          agent: row.agent,
          taskName: row.task_name,
          status: row.status,
          lastSeenAt: new Date(row.last_seen_at).toISOString(),
          ...(row.branch ? { branch: row.branch } : {}),
          changedFiles,
          moreFiles: Math.max(
            0,
            Number(row.changed_count) - changedFiles.length,
          ),
          staleRefs: (row.stale_refs ?? []).slice(0, 5),
        };
      }),
      blockers: blockers.rows.map((row) => row.title),
    };
  }

  async gate(input: {
    projectKey?: string;
    agent: string;
    sessionId: string;
    cwd?: string;
  }): Promise<{ blocked: boolean; refs: string[] }> {
    const projectKey = input.projectKey?.trim();
    let resolvedProjectKey = projectKey;
    if (!resolvedProjectKey && input.cwd) {
      const fingerprint = await this.resolver.resolve(input.cwd);
      resolvedProjectKey = (await this.resolveProject(fingerprint.root))
        ?.project_key;
    }
    if (!resolvedProjectKey) return { blocked: false, refs: [] };
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
      [resolvedProjectKey, input.agent, input.sessionId],
    );
    return {
      blocked: result.rows.length > 0,
      refs: result.rows.map((row) => row.ref),
    };
  }

  async status(input: {
    cwd: string;
    projectKey?: string;
  }): Promise<ActivityStatus> {
    const fingerprint = await this.resolver.resolve(input.cwd);
    const project = await this.resolveProject(
      fingerprint.root,
      input.projectKey,
    );
    if (!project)
      return {
        projectKey: null,
        lastEventAt: { claude: null, codex: null },
      };
    const activity = (
      await this.pool.query<{
        claude_last_seen_at: Date | string | null;
        codex_last_seen_at: Date | string | null;
      }>(
        `SELECT
           max(task.last_seen_at) FILTER (WHERE task.agent='claude') AS claude_last_seen_at,
           max(task.last_seen_at) FILTER (WHERE task.agent='codex') AS codex_last_seen_at
         FROM project_knowledge.agent_tasks task
         JOIN project_knowledge.worktrees worktree ON worktree.id=task.worktree_id
         WHERE task.project_id=$1 AND lower(worktree.path)=lower($2)`,
        [project.project_id, path.resolve(fingerprint.root)],
      )
    ).rows[0];
    return {
      projectKey: project.project_key,
      lastEventAt: {
        claude: isoString(activity?.claude_last_seen_at ?? null),
        codex: isoString(activity?.codex_last_seen_at ?? null),
      },
    };
  }
}
