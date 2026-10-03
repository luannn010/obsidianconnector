import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { canonicalHash, projectionHash } from '../knowledge/hash.js';
import { KnowledgeError } from '../knowledge/errors.js';
import type { PgPoolLike } from '../knowledge/pg-store.js';
import type {
  MaterializeProjectViewsResult,
  ProjectViewsPreview,
} from '../knowledge/types.js';
import {
  DEFAULT_PROJECT_VIEWS_CONFIG,
  readProjectViewsConfig,
} from './project-views-config-service.js';
import {
  buildLazyProjectViews,
  type LazyProjectView,
  type LazyProjectViewData,
  worktreeFolderName,
} from '../worker/lazy-project-views.js';
import {
  archiveProjection,
  publishProjection,
  renderManagedNote,
} from '../worker/projection.js';

export interface ProjectViewsInput {
  projectKey: string;
  worktreePath: string;
  vaultPath: string;
  views?: Array<'project-now' | 'worktree-now'>;
  worktreeIds?: string[];
  knownPreviewHash?: string;
  /** Git-authoritative paths reconciled by the operation runner. */
  liveWorktreePaths?: string[];
}

export interface MaterializeProjectViewsInput extends ProjectViewsInput {
  previewHash: string;
}

interface ExistingProjection extends Record<string, unknown> {
  id: string;
  view_id: string;
  relative_path: string;
  db_revision: number;
  state: string;
  projection_hash: string;
  observed_hash: string | null;
  last_published_hash: string | null;
  preserved_path: string | null;
  worktree_id?: string | null;
}

type Publisher = typeof publishProjection;

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function worktreeArchivePath(relativePath: string): string {
  const folder = path.posix.basename(
    path.posix.dirname(relativePath.replaceAll('\\', '/')),
  );
  return `Archive/Worktrees/${folder}/Now.md`;
}

export class LazyProjectViewsService {
  private readonly now: () => Date;
  private readonly publish: Publisher;

  constructor(
    private readonly pool: PgPoolLike,
    options: { now?: () => Date; publish?: Publisher } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.publish = options.publish ?? publishProjection;
  }

  async preview(input: ProjectViewsInput): Promise<ProjectViewsPreview> {
    const built = await this.build(input);
    const activeViews = built.views.map(({ view, desiredHash, existing }) => {
      const unchanged =
        existing?.last_published_hash === desiredHash &&
        existing.relative_path === view.relativePath &&
        existing.state === 'current';
      const conflicted = existing?.state === 'drifted';
      return {
        viewId: view.viewId,
        relativePath: view.relativePath,
        state: conflicted
          ? ('conflicted' as const)
          : unchanged
            ? ('unchanged' as const)
            : ('changed' as const),
        reason: conflicted
          ? 'The previously published note was edited outside the projector.'
          : unchanged
            ? 'The rendered content hash is unchanged.'
            : existing
              ? 'The rendered content or output path changed.'
              : 'The named view has not been published yet.',
        desiredHash,
        ...(view.worktreeId ? { worktreeId: view.worktreeId } : {}),
      };
    });
    const views = [
      ...activeViews,
      ...built.retired.map((existing) => ({
        viewId: existing.view_id,
        relativePath: worktreeArchivePath(existing.relative_path),
        state:
          existing.state === 'drifted'
            ? ('conflicted' as const)
            : ('changed' as const),
        reason:
          existing.state === 'drifted'
            ? 'The retired worktree note has unresolved human edits.'
            : 'The Git worktree is no longer live and its managed note will be archived.',
        desiredHash: existing.last_published_hash ?? existing.projection_hash,
        ...(existing.worktree_id ? { worktreeId: existing.worktree_id } : {}),
      })),
    ];
    const previewHash = canonicalHash(views);
    if (input.knownPreviewHash === previewHash)
      return {
        projectKey: input.projectKey,
        dbRevision: built.dbRevision,
        status: 'not_modified',
        previewHash,
        estimatedWrites: 0,
        views: [],
      };
    return {
      projectKey: input.projectKey,
      dbRevision: built.dbRevision,
      status: 'modified',
      previewHash,
      estimatedWrites: views.filter((view) => view.state !== 'unchanged')
        .length,
      views,
    };
  }

  async materialize(
    input: MaterializeProjectViewsInput,
  ): Promise<MaterializeProjectViewsResult> {
    const preview = await this.preview({
      ...input,
      knownPreviewHash: undefined,
    });
    if (preview.previewHash !== input.previewHash)
      throw new KnowledgeError(
        'VERSION_CONFLICT',
        'Named view preview changed before materialization',
        false,
        { expected: input.previewHash, actual: preview.previewHash },
      );
    const built = await this.build(input);
    let published = 0;
    let unchanged = 0;
    let conflicted = 0;
    const paths: string[] = [];
    for (const candidate of built.views) {
      if (candidate.existing?.state === 'drifted') {
        conflicted++;
        continue;
      }
      if (
        candidate.existing?.last_published_hash === candidate.desiredHash &&
        candidate.existing.relative_path === candidate.view.relativePath &&
        candidate.existing.state === 'current'
      ) {
        unchanged++;
        continue;
      }
      if (
        candidate.existing &&
        candidate.existing.relative_path !== candidate.view.relativePath &&
        candidate.existing.relative_path
          .replaceAll('\\', '/')
          .startsWith('Published/Worktrees/')
      ) {
        const archived = await archiveProjection(
          input.vaultPath,
          candidate.existing.relative_path,
          worktreeArchivePath(candidate.existing.relative_path),
          candidate.existing.last_published_hash ?? undefined,
        );
        if (archived.conflicted) {
          conflicted++;
          await this.pool.query(
            `UPDATE project_knowledge.note_projections
             SET state='drifted',observed_hash=$3,updated_at=now()
             WHERE project_id=$1 AND view_id=$2`,
            [
              built.projectId,
              candidate.view.viewId,
              archived.observedHash ?? null,
            ],
          );
          if (archived.preservedPath)
            await this.pool.query(
              `INSERT INTO project_knowledge.projection_conflicts
               (project_id,projection_id,expected_hash,observed_hash,preserved_path)
               SELECT $1,$2,$3,$4,$5
               WHERE NOT EXISTS (
                 SELECT 1 FROM project_knowledge.projection_conflicts
                 WHERE projection_id=$2 AND observed_hash=$4 AND resolved_at IS NULL
               )`,
              [
                built.projectId,
                candidate.existing.id,
                candidate.existing.last_published_hash ?? candidate.desiredHash,
                archived.observedHash ?? 'unknown',
                archived.preservedPath,
              ],
            );
          continue;
        }
      }
      const result = await this.publish(
        input.vaultPath,
        candidate.view.relativePath,
        candidate.rendered,
        candidate.existing?.last_published_hash ?? undefined,
      );
      const projectionId = candidate.existing?.id ?? randomUUID();
      await this.pool.query(
        `INSERT INTO project_knowledge.note_projections
         (id,project_id,view_id,relative_path,db_revision,canonical_hash,projection_hash,
          observed_hash,last_published_hash,state,worktree_id,source_snapshot_id)
         VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(project_id,view_id) DO UPDATE SET
           relative_path=EXCLUDED.relative_path,db_revision=EXCLUDED.db_revision,
           canonical_hash=EXCLUDED.canonical_hash,projection_hash=EXCLUDED.projection_hash,
           observed_hash=EXCLUDED.observed_hash,
           last_published_hash=CASE WHEN EXCLUDED.state='current' THEN EXCLUDED.projection_hash ELSE project_knowledge.note_projections.last_published_hash END,
           state=EXCLUDED.state,worktree_id=EXCLUDED.worktree_id,
           source_snapshot_id=EXCLUDED.source_snapshot_id,updated_at=now()`,
        [
          projectionId,
          built.projectId,
          candidate.view.viewId,
          candidate.view.relativePath,
          built.dbRevision,
          candidate.desiredHash,
          result.observedHash,
          result.state === 'current'
            ? candidate.desiredHash
            : (candidate.existing?.last_published_hash ?? null),
          result.state,
          candidate.view.worktreeId ?? null,
          candidate.view.metadata.source_snapshot_id === 'unindexed'
            ? null
            : (candidate.view.metadata.source_snapshot_id ?? null),
        ],
      );
      if (result.state === 'drifted') {
        conflicted++;
        if (result.conflictCreated && result.preservedPath)
          await this.pool.query(
            `INSERT INTO project_knowledge.projection_conflicts
             (project_id,projection_id,expected_hash,observed_hash,preserved_path)
             SELECT $1,$2,$3,$4,$5
             WHERE NOT EXISTS (
               SELECT 1 FROM project_knowledge.projection_conflicts
               WHERE projection_id=$2 AND observed_hash=$4 AND resolved_at IS NULL
             )`,
            [
              built.projectId,
              projectionId,
              candidate.desiredHash,
              result.observedHash,
              result.preservedPath,
            ],
          );
      } else {
        published++;
        paths.push(candidate.view.relativePath);
      }
    }
    for (const retired of built.retired) {
      if (retired.state === 'drifted') {
        conflicted++;
        continue;
      }
      const archived = await archiveProjection(
        input.vaultPath,
        retired.relative_path,
        worktreeArchivePath(retired.relative_path),
        retired.last_published_hash ?? undefined,
      );
      if (archived.conflicted) {
        conflicted++;
        if (archived.preservedPath)
          await this.pool.query(
            `INSERT INTO project_knowledge.projection_conflicts
             (project_id,projection_id,expected_hash,observed_hash,preserved_path)
             SELECT $1,$2,$3,$4,$5
             WHERE NOT EXISTS (
               SELECT 1 FROM project_knowledge.projection_conflicts
               WHERE projection_id=$2 AND observed_hash=$4 AND resolved_at IS NULL
             )`,
            [
              built.projectId,
              retired.id,
              retired.last_published_hash ?? retired.projection_hash,
              archived.observedHash ?? 'unknown',
              archived.preservedPath,
            ],
          );
      } else if (archived.archived) {
        paths.push(archived.archivePath!);
        await this.pool.query(
          `UPDATE project_knowledge.note_projections
           SET relative_path=$3,state='deferred',updated_at=now()
           WHERE project_id=$1 AND view_id=$2`,
          [built.projectId, retired.view_id, archived.archivePath],
        );
      }
    }
    return {
      projectKey: input.projectKey,
      dbRevision: built.dbRevision,
      previewHash: input.previewHash,
      published,
      unchanged,
      conflicted,
      paths,
    };
  }

  private async build(input: ProjectViewsInput): Promise<{
    projectId: string;
    dbRevision: number;
    views: Array<{
      view: LazyProjectView;
      rendered: string;
      desiredHash: string;
      existing?: ExistingProjection;
    }>;
    retired: ExistingProjection[];
  }> {
    const project = (
      await this.pool.query<{
        project_id: string;
        db_revision: number;
        updated_at: Date | string;
      }>(
        'SELECT project_id,db_revision,updated_at FROM project_knowledge.projects WHERE project_key=$1',
        [input.projectKey],
      )
    ).rows[0];
    if (!project)
      throw new KnowledgeError(
        'INDEX_STALE',
        'Project is not registered',
        false,
      );
    const worktrees = (
      await this.pool.query<{
        id: string;
        path: string;
        branch: string;
        head_commit: string;
        dirty_hash: string | null;
        dirty_path_count: number;
        last_seen_at: Date | string;
        snapshot_id: string | null;
        snapshot_fresh: boolean;
      }>(
        `SELECT worktree.id,worktree.path,worktree.branch,worktree.head_commit,
           worktree.dirty_hash,cardinality(worktree.dirty_paths) AS dirty_path_count,
           COALESCE((SELECT max(task.last_seen_at) FROM project_knowledge.agent_tasks task
             WHERE task.worktree_id=worktree.id),snapshot.activated_at,
             (SELECT updated_at FROM project_knowledge.projects WHERE project_id=worktree.project_id)) AS last_seen_at,
           snapshot.id AS snapshot_id,
           COALESCE(snapshot.head_commit=worktree.head_commit AND snapshot.dirty_hash IS NOT DISTINCT FROM worktree.dirty_hash,false) AS snapshot_fresh
         FROM project_knowledge.worktrees worktree
         LEFT JOIN LATERAL (
           SELECT id,head_commit,dirty_hash,activated_at FROM project_knowledge.source_snapshots
           WHERE worktree_id=worktree.id AND state='active'
           ORDER BY activated_at DESC NULLS LAST LIMIT 1
         ) snapshot ON true
         WHERE worktree.project_id=$1 AND worktree.registered ORDER BY worktree.branch,worktree.id`,
        [project.project_id],
      )
    ).rows.filter(
      (row) =>
        !input.liveWorktreePaths ||
        input.liveWorktreePaths.some(
          (livePath) =>
            path.resolve(livePath).toLowerCase() ===
            path.resolve(row.path).toLowerCase(),
        ),
    );
    const tasks = (
      await this.pool.query<{
        id: string;
        worktree_id: string;
        task_name: string;
        status: string;
        last_seen_at: Date | string;
      }>(
        `SELECT id,worktree_id,task_name,status,last_seen_at
         FROM project_knowledge.agent_tasks WHERE project_id=$1 AND worktree_id IS NOT NULL
         ORDER BY last_seen_at DESC LIMIT 50`,
        [project.project_id],
      )
    ).rows;
    const workItems = (
      await this.pool.query<{
        title: string;
        status: string;
        verification_status: string;
        blocker: string | null;
        worktree_ids: string[];
      }>(
        `SELECT item.title,work.status,work.verification_status,work.blocker,
           COALESCE(array_agg(DISTINCT link.worktree_id) FILTER(WHERE link.worktree_id IS NOT NULL),'{}') AS worktree_ids
         FROM project_knowledge.work_items work
         JOIN project_knowledge.knowledge_items item ON item.id=work.item_id
         LEFT JOIN project_knowledge.worktree_links link ON link.work_item_id=work.id
         WHERE work.project_id=$1
         GROUP BY item.title,work.status,work.verification_status,work.blocker
         ORDER BY work.status,item.title`,
        [project.project_id],
      )
    ).rows;
    const changes = (
      await this.pool.query<{
        new_revision: number;
        message: string;
        reason: string;
        created_at: Date | string;
        worktree_ids: string[];
      }>(
        `SELECT change.new_revision,change.message,change.reason,change.created_at,
           COALESCE(array_agg(DISTINCT COALESCE(task.worktree_id,link.worktree_id))
             FILTER(WHERE COALESCE(task.worktree_id,link.worktree_id) IS NOT NULL),'{}') AS worktree_ids
         FROM project_knowledge.knowledge_change_sets change
         LEFT JOIN project_knowledge.agent_tasks task
           ON task.project_id=change.project_id AND task.external_task_id=change.task_id
         LEFT JOIN project_knowledge.knowledge_change_entries entry ON entry.change_set_id=change.id
         LEFT JOIN project_knowledge.work_items work ON work.item_id=entry.item_id
         LEFT JOIN project_knowledge.worktree_links link ON link.work_item_id=work.id
         WHERE change.project_id=$1 AND change.new_revision>change.base_revision
         GROUP BY change.id ORDER BY change.new_revision DESC LIMIT 500`,
        [project.project_id],
      )
    ).rows;
    const health = (
      await this.pool.query<{
        failed_jobs: number;
        projection_conflicts: number;
        stale_evidence: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM project_knowledge.outbox_jobs WHERE project_id=$1 AND state='failed') AS failed_jobs,
           (SELECT count(*)::int FROM project_knowledge.projection_conflicts WHERE project_id=$1 AND resolved_at IS NULL) AS projection_conflicts,
           (SELECT count(*)::int FROM project_knowledge.documentation_freshness WHERE project_id=$1 AND state IN ('stale','missing')) AS stale_evidence`,
        [project.project_id],
      )
    ).rows[0] ?? { failed_jobs: 0, projection_conflicts: 0, stale_evidence: 0 };
    const existingRows = (
      await this.pool.query<ExistingProjection>(
        `SELECT projection.*,
           (SELECT conflict.preserved_path FROM project_knowledge.projection_conflicts conflict
            WHERE conflict.projection_id=projection.id AND conflict.resolved_at IS NULL
            ORDER BY conflict.created_at DESC LIMIT 1) AS preserved_path
         FROM project_knowledge.note_projections projection
         WHERE projection.project_id=$1 AND (projection.view_id='project-now' OR projection.view_id LIKE 'worktree:%:now')`,
        [project.project_id],
      )
    ).rows;
    const existing = new Map(existingRows.map((row) => [row.view_id, row]));
    const mappedChanges = changes.map((row) => ({
      revision: Number(row.new_revision),
      message: row.message,
      reason: row.reason,
      createdAt: iso(row.created_at),
      worktreeIds: row.worktree_ids,
    }));
    const firstPublicationCutoff =
      this.now().getTime() - 14 * 24 * 60 * 60 * 1_000;
    const data: LazyProjectViewData = {
      projectId: project.project_id,
      projectKey: input.projectKey,
      dbRevision: Number(project.db_revision),
      generatedAt: project.updated_at
        ? iso(project.updated_at)
        : '1970-01-01T00:00:00.000Z',
      failedJobs: Number(health.failed_jobs),
      projectionConflicts: Number(health.projection_conflicts),
      staleEvidence: Number(health.stale_evidence),
      worktrees: worktrees.map((row) => ({
        id: row.id,
        path: row.path,
        branch: row.branch ?? '',
        head: row.head_commit,
        dirty: Boolean(row.dirty_hash),
        dirtyPathCount: Number(row.dirty_path_count),
        ...(row.snapshot_id ? { snapshotId: row.snapshot_id } : {}),
        snapshotFresh: row.snapshot_fresh,
        lastSeenAt: iso(row.last_seen_at),
      })),
      tasks: tasks.map((row) => ({
        id: row.id,
        worktreeId: row.worktree_id,
        name: row.task_name,
        status: row.status,
        lastSeenAt: iso(row.last_seen_at),
      })),
      workItems: workItems.map((row) => ({
        title: row.title,
        status: row.status,
        verificationStatus: row.verification_status,
        ...(row.blocker ? { blocker: row.blocker } : {}),
        worktreeIds: row.worktree_ids,
      })),
      changes: mappedChanges.filter(
        (change) => Date.parse(change.createdAt) >= firstPublicationCutoff,
      ),
    };
    const viewConfig =
      (await readProjectViewsConfig(input.worktreePath)) ??
      DEFAULT_PROJECT_VIEWS_CONFIG;
    const configuredKinds = Object.entries(viewConfig.views)
      .filter(([, view]) =>
        ['project-now', 'worktree-now'].includes(view.renderer),
      )
      .map(([viewId]) => viewId as 'project-now' | 'worktree-now');
    const selectedKinds = new Set(input.views ?? configuredKinds);
    const renderViews = (source: LazyProjectViewData) =>
      buildLazyProjectViews(source, {
        projectNow: viewConfig.views['project-now']?.limits,
        worktreeNow: viewConfig.views['worktree-now']?.limits,
      });
    const selectedWorktrees = input.worktreeIds
      ? new Set(input.worktreeIds)
      : undefined;
    const applyConfiguredPath = (view: LazyProjectView): LazyProjectView => {
      const config = viewConfig.views[view.viewType];
      if (view.viewType === 'project-now' && config?.path)
        return { ...view, relativePath: config.path };
      if (
        view.viewType === 'worktree-now' &&
        config?.pathTemplate &&
        view.worktreeId
      ) {
        const worktree = data.worktrees.find(
          (candidate) => candidate.id === view.worktreeId,
        );
        if (worktree) {
          const folder = worktreeFolderName(worktree.branch, worktree.id);
          const renderedFolder = path.posix.basename(
            path.posix.dirname(view.relativePath.replaceAll('\\', '/')),
          );
          const separator = renderedFolder.lastIndexOf('--');
          const branchSlug =
            separator >= 0
              ? renderedFolder.slice(0, separator)
              : folder.slice(0, -10);
          const stableId =
            separator >= 0
              ? renderedFolder.slice(separator + 2)
              : worktree.id.slice(0, 8);
          return {
            ...view,
            relativePath: config.pathTemplate
              .replaceAll('{branchSlug}', branchSlug)
              .replaceAll('{worktreeId8}', stableId),
          };
        }
      }
      return view;
    };
    const views = renderViews(data)
      .map(applyConfiguredPath)
      .filter(
        (view) =>
          selectedKinds.has(view.viewType) &&
          (!view.worktreeId ||
            !selectedWorktrees ||
            selectedWorktrees.has(view.worktreeId)),
      );
    return {
      projectId: project.project_id,
      dbRevision: Number(project.db_revision),
      views: views.map((initialView) => {
        const previous = existing.get(initialView.viewId);
        const view = previous
          ? (renderViews({
              ...data,
              changes: mappedChanges.filter(
                (change) => change.revision > Number(previous.db_revision),
              ),
            })
              .map(applyConfiguredPath)
              .find((candidate) => candidate.viewId === initialView.viewId) ??
            initialView)
          : initialView;
        const rendered = renderManagedNote({
          viewId: view.viewId,
          projectId: project.project_id,
          viewType: view.viewType,
          dbRevision: Number(project.db_revision),
          gitRevision: view.worktreeId
            ? data.worktrees.find((worktree) => worktree.id === view.worktreeId)
                ?.head
            : undefined,
          generatedAt: data.generatedAt,
          metadata: view.metadata,
          body: view.body,
        });
        return {
          view,
          rendered,
          desiredHash: projectionHash(rendered),
          ...(existing.get(view.viewId)
            ? { existing: existing.get(view.viewId)! }
            : {}),
        };
      }),
      retired:
        selectedKinds.has('worktree-now') && !selectedWorktrees
          ? existingRows.filter(
              (row) =>
                row.view_id.startsWith('worktree:') &&
                row.relative_path
                  .replaceAll('\\', '/')
                  .startsWith('Published/Worktrees/') &&
                (!row.worktree_id ||
                  !data.worktrees.some(
                    (worktree) => worktree.id === row.worktree_id,
                  )),
            )
          : [],
    };
  }
}
