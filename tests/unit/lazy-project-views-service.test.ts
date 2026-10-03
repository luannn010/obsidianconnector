import { describe, expect, it, vi } from 'vitest';
import type {
  PgPoolLike,
  PgQueryResult,
} from '../../src/knowledge/pg-store.js';
import { LazyProjectViewsService } from '../../src/services/lazy-project-views-service.js';

function pool(): PgPoolLike {
  return {
    connect: async () => {
      throw new Error('not used');
    },
    query: async <Row extends Record<string, unknown>>(
      sql: string,
    ): Promise<PgQueryResult<Row>> => {
      if (
        sql.startsWith(
          'SELECT project_id,db_revision,updated_at FROM project_knowledge.projects',
        )
      )
        return {
          rows: [
            { project_id: 'project-1', db_revision: 7 },
          ] as unknown as Row[],
        };
      if (sql.includes('FROM project_knowledge.worktrees worktree'))
        return {
          rows: [
            {
              id: '24ce84ef-8462-474d-91f2-ef30d4ed7b02',
              path: 'C:/repo',
              branch: 'master',
              head_commit: 'abcdef0123456789',
              dirty_hash: null,
              dirty_path_count: 0,
              last_seen_at: new Date('2026-09-25T00:00:00Z'),
              snapshot_id: 'snapshot-1',
              snapshot_fresh: true,
            },
          ] as unknown as Row[],
        };
      if (sql.includes('FROM project_knowledge.agent_tasks'))
        return { rows: [] };
      if (sql.includes('FROM project_knowledge.work_items'))
        return { rows: [] };
      if (sql.includes('FROM project_knowledge.knowledge_change_sets'))
        return { rows: [] };
      if (sql.includes('AS failed_jobs'))
        return {
          rows: [
            { failed_jobs: 0, projection_conflicts: 0, stale_evidence: 0 },
          ] as unknown as Row[],
        };
      if (sql.includes('FROM project_knowledge.note_projections'))
        return { rows: [] };
      return { rows: [] };
    },
  };
}

describe('lazy project view service', () => {
  it('excludes database-only worktrees absent from the reconciled Git list', async () => {
    const service = new LazyProjectViewsService(pool());
    const result = await service.preview({
      projectKey: 'MC-Platform',
      worktreePath: 'C:/repo',
      vaultPath: 'C:/vault',
      liveWorktreePaths: [],
    });
    expect(result.views.map((view) => view.viewId)).toEqual(['project-now']);
  });
  it('previews changed views without publishing note bodies', async () => {
    const publish = vi.fn();
    const service = new LazyProjectViewsService(pool(), {
      now: () => new Date('2026-09-25T00:00:00Z'),
      publish,
    });
    const preview = await service.preview({
      projectKey: 'MC-Platform',
      worktreePath: 'C:/repo',
      vaultPath: 'C:/vault',
    });

    expect(preview.status).toBe('modified');
    expect(preview.estimatedWrites).toBe(2);
    expect(preview.views.map((view) => view.viewId)).toEqual([
      'project-now',
      'worktree:24ce84ef-8462-474d-91f2-ef30d4ed7b02:now',
    ]);
    expect(preview.views[0]).not.toHaveProperty('body');
    await expect(
      service.preview({
        projectKey: 'MC-Platform',
        worktreePath: 'C:/repo',
        vaultPath: 'C:/vault',
        knownPreviewHash: preview.previewHash,
      }),
    ).resolves.toMatchObject({ status: 'not_modified', views: [] });
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects materialization when the approved preview hash is stale', async () => {
    const publish = vi.fn();
    const service = new LazyProjectViewsService(pool(), {
      now: () => new Date('2026-09-25T00:00:00Z'),
      publish,
    });

    await expect(
      service.materialize({
        projectKey: 'MC-Platform',
        worktreePath: 'C:/repo',
        vaultPath: 'C:/vault',
        previewHash: 'stale-preview',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes only changed views after a matching preview', async () => {
    const publish = vi.fn(async () => ({
      state: 'current' as const,
      observedHash: 'written',
    }));
    const service = new LazyProjectViewsService(pool(), {
      now: () => new Date('2026-09-25T00:00:00Z'),
      publish,
    });
    const preview = await service.preview({
      projectKey: 'MC-Platform',
      worktreePath: 'C:/repo',
      vaultPath: 'C:/vault',
    });
    const result = await service.materialize({
      projectKey: 'MC-Platform',
      worktreePath: 'C:/repo',
      vaultPath: 'C:/vault',
      previewHash: preview.previewHash,
    });

    expect(result).toMatchObject({ published: 2, unchanged: 0, conflicted: 0 });
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
