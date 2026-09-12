import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { countSerializedTokens } from '../knowledge/token-budget.js';
import {
  canonicalHash,
  projectionHash,
  sourceHash,
} from '../knowledge/hash.js';
import type { EmbeddingProvider } from '../knowledge/pg-store.js';
import {
  changedIndexableFiles,
  fingerprintWorktree,
  listIndexableFiles,
  listRegisteredWorktrees,
  shouldIndexPath,
} from './git-worktree.js';
import { inventoryLegacyNotes } from './legacy-inventory.js';
import { parseSourceUnits } from './source-parser.js';
import { buildProjectViews, type ProjectViewData } from './vault-views.js';
import {
  publishProjection,
  removeProjection,
  renderManagedNote,
} from './projection.js';
import { PgKnowledgeStore } from '../knowledge/pg-store.js';
import matter from 'gray-matter';
import { parseDatabaseMigration } from './database-parser.js';
import { parseApiContracts } from './api-contract-parser.js';
import { parseSequenceFlows } from './sequence-parser.js';
import { buildDomainSyncReport, importDomainManifest } from './domain-audit.js';
import { deactivateMissingWorktrees } from './worktree-lifecycle.js';
import { EmbeddingQueueProcessor } from './embedding-queue-processor.js';

export interface WorkerProject {
  projectKey: string;
  name: string;
  repositoryPath: string;
  vaultPath: string;
}

const SOURCE_PARSER_REVISION = 'structural-v2';

function dirtyPaths(status: string): string[] {
  return status
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const raw = line.slice(3).trim();
      return raw.includes(' -> ') ? raw.split(' -> ').at(-1)! : raw;
    })
    .filter(Boolean)
    .sort();
}

function languageFor(file: string): string {
  return path.extname(file).slice(1).toLowerCase() || 'text';
}
function deliveryStatus(value: unknown): string {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['verified', 'implemented', 'completed', 'complete'].includes(status))
    return 'completed';
  if (
    status === 'active' ||
    status === 'in-progress' ||
    status.includes('pending-production')
  )
    return 'active';
  if (status === 'blocked') return 'blocked';
  if (status === 'planned' || status === 'proposed') return 'planned';
  return 'needs_review';
}

export async function clearChangedSnapshotRows(
  client: { query(sql: string, values?: unknown[]): Promise<unknown> },
  snapshotId: string,
  changedPaths: string[],
): Promise<void> {
  await client.query(
    `DELETE FROM project_knowledge.code_symbols symbols
     USING project_knowledge.code_files files
     WHERE symbols.file_id=files.id AND files.snapshot_id=$1
       AND files.repo_relative_path=ANY($2::text[])`,
    [snapshotId, changedPaths],
  );
  await client.query(
    "DELETE FROM project_knowledge.search_chunks WHERE snapshot_id=$1 AND metadata->>'path'=ANY($2::text[])",
    [snapshotId, changedPaths],
  );
  await client.query(
    'DELETE FROM project_knowledge.code_files WHERE snapshot_id=$1 AND repo_relative_path=ANY($2::text[])',
    [snapshotId, changedPaths],
  );
}

export function appendIndexablePreviousDirtyPaths(
  changes: Array<{ status: string; path: string }>,
  previousDirtyPaths: string[],
): void {
  for (const oldDirty of previousDirtyPaths)
    if (
      shouldIndexPath(oldDirty) &&
      !changes.some((change) => change.path === oldDirty)
    )
      changes.push({ status: 'M', path: oldDirty });
}

export class KnowledgeWorker {
  private readonly embeddingQueue?: EmbeddingQueueProcessor;

  constructor(
    private readonly pool: Pool,
    private readonly embedder?: EmbeddingProvider,
    private readonly embeddingModel = {
      name: 'BAAI/bge-large-en-v1.5',
      revision: 'local',
      dimensions: 1024,
    },
  ) {
    if (embedder)
      this.embeddingQueue = new EmbeddingQueueProcessor(
        pool,
        embedder,
        embeddingModel,
      );
  }

  async reconcile(
    project: WorkerProject,
    options: { primaryRepositoryPath?: string } = {},
  ): Promise<{ changed: boolean; snapshotId: string; indexedFiles: number }> {
    const fingerprint = await fingerprintWorktree(project.repositoryPath);
    const currentDirty = dirtyPaths(fingerprint.status);
    const primaryRepositoryPath = path.resolve(
      options.primaryRepositoryPath ?? fingerprint.root,
    );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const projectRow = (
        await client.query<{ project_id: string }>(
          `
        INSERT INTO project_knowledge.projects(project_key,name) VALUES($1,$2)
        ON CONFLICT(project_key) DO UPDATE SET name=EXCLUDED.name,updated_at=now()
        RETURNING project_id`,
          [project.projectKey, project.name],
        )
      ).rows[0]!;
      const repository = (
        await client.query<{ id: string }>(
          `
        INSERT INTO project_knowledge.repositories(project_id,name,root_path,default_branch)
        VALUES($1,$2,$3,$4) ON CONFLICT(project_id,root_path) DO UPDATE SET name=EXCLUDED.name
        RETURNING id`,
          [
            projectRow.project_id,
            project.name,
            primaryRepositoryPath,
            fingerprint.branch,
          ],
        )
      ).rows[0]!;
      const worktree = (
        await client.query<{ id: string }>(
          `
        INSERT INTO project_knowledge.worktrees(project_id,repository_id,path,branch,head_commit,dirty_hash,dirty_paths)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(project_id,path) DO UPDATE SET
          repository_id=EXCLUDED.repository_id,branch=EXCLUDED.branch,
          head_commit=EXCLUDED.head_commit,dirty_hash=EXCLUDED.dirty_hash,
          dirty_paths=EXCLUDED.dirty_paths,registered=true,last_seen_at=now()
        RETURNING id`,
          [
            projectRow.project_id,
            repository.id,
            fingerprint.root,
            fingerprint.branch,
            fingerprint.head,
            fingerprint.dirtyHash,
            currentDirty,
          ],
        )
      ).rows[0]!;
      await importDomainManifest(
        client,
        projectRow.project_id,
        fingerprint.root,
      );
      const previous = (
        await client.query<{
          id: string;
          head_commit: string;
          dirty_hash: string | null;
          dirty_paths: string[];
          parser_revision: string;
        }>(
          `
        SELECT id,head_commit,dirty_hash,dirty_paths,parser_revision FROM project_knowledge.source_snapshots
        WHERE project_id=$1 AND worktree_id=$2 AND state='active' ORDER BY activated_at DESC LIMIT 1`,
          [projectRow.project_id, worktree.id],
        )
      ).rows[0];
      if (
        previous?.head_commit === fingerprint.head &&
        previous.dirty_hash === fingerprint.dirtyHash &&
        previous.parser_revision === SOURCE_PARSER_REVISION
      ) {
        await client.query(
          `UPDATE project_knowledge.worktrees SET branch=$2,head_commit=$3,dirty_hash=$4,
             dirty_paths=$5,last_seen_at=now() WHERE id=$1`,
          [
            worktree.id,
            fingerprint.branch,
            fingerprint.head,
            fingerprint.dirtyHash,
            currentDirty,
          ],
        );
        await client.query('COMMIT');
        return { changed: false, snapshotId: previous.id, indexedFiles: 0 };
      }
      const snapshot = (
        await client.query<{ id: string }>(
          `
        INSERT INTO project_knowledge.source_snapshots(project_id,worktree_id,head_commit,dirty_hash,dirty_paths,state,parser_revision)
        VALUES($1,$2,$3,$4,$5,'building',$6) RETURNING id`,
          [
            projectRow.project_id,
            worktree.id,
            fingerprint.head,
            fingerprint.dirtyHash,
            currentDirty,
            SOURCE_PARSER_REVISION,
          ],
        )
      ).rows[0]!;
      let changes: Array<{
        status: string;
        path: string;
        previousPath?: string;
      }>;
      if (previous) {
        changes =
          previous.parser_revision === SOURCE_PARSER_REVISION
            ? await changedIndexableFiles(
                fingerprint.root,
                previous.head_commit,
                fingerprint.head,
                fingerprint.status,
              )
            : (await listIndexableFiles(fingerprint.root)).map((file) => ({
                status: 'A',
                path: file,
              }));
        appendIndexablePreviousDirtyPaths(changes, previous.dirty_paths ?? []);
        await client.query(
          `INSERT INTO project_knowledge.code_files(id,project_id,snapshot_id,repo_relative_path,language,source_hash,deleted)
          SELECT gen_random_uuid(),project_id,$2,repo_relative_path,language,source_hash,deleted FROM project_knowledge.code_files WHERE snapshot_id=$1`,
          [previous.id, snapshot.id],
        );
        await client.query(
          `INSERT INTO project_knowledge.code_symbols(project_id,snapshot_id,file_id,qualified_name,symbol_kind,signature,start_line,end_line)
          SELECT s.project_id,$2,nf.id,s.qualified_name,s.symbol_kind,s.signature,s.start_line,s.end_line
          FROM project_knowledge.code_symbols s JOIN project_knowledge.code_files of ON of.id=s.file_id
          JOIN project_knowledge.code_files nf ON nf.snapshot_id=$2 AND nf.repo_relative_path=of.repo_relative_path
          WHERE s.snapshot_id=$1`,
          [previous.id, snapshot.id],
        );
        await client.query(
          `INSERT INTO project_knowledge.search_chunks(project_id,item_id,snapshot_id,parent_ref,kind,domain,service,worktree_id,title,content,content_hash,token_count,embedding,embedding_model_id,metadata)
          SELECT project_id,item_id,$2,parent_ref,kind,domain,service,worktree_id,title,content,content_hash,token_count,embedding,embedding_model_id,metadata
          FROM project_knowledge.search_chunks WHERE snapshot_id=$1`,
          [previous.id, snapshot.id],
        );
      } else {
        changes = (await listIndexableFiles(fingerprint.root)).map((file) => ({
          status: 'A',
          path: file,
        }));
      }
      const changedPaths = [
        ...new Set(
          changes.flatMap((change) => [
            change.path,
            ...(change.previousPath ? [change.previousPath] : []),
          ]),
        ),
      ];
      if (changedPaths.length) {
        await clearChangedSnapshotRows(client, snapshot.id, changedPaths);
      }
      let indexedFiles = 0;
      for (const change of changes) {
        const absolute = path.resolve(fingerprint.root, change.path);
        if (
          change.status === 'D' ||
          !absolute.startsWith(`${fingerprint.root}${path.sep}`)
        )
          continue;
        const content = await readFile(absolute, 'utf8').catch(() => undefined);
        if (content === undefined || content.includes('\u0000')) continue;
        const fileHash = sourceHash(content);
        const file = (
          await client.query<{ id: string }>(
            `
          INSERT INTO project_knowledge.code_files(project_id,snapshot_id,repo_relative_path,language,source_hash)
          VALUES($1,$2,$3,$4,$5) RETURNING id`,
            [
              projectRow.project_id,
              snapshot.id,
              change.path.replace(/\\/gu, '/'),
              languageFor(change.path),
              fileHash,
            ],
          )
        ).rows[0]!;
        const units = parseSourceUnits(change.path, content);
        const effectiveUnits = units.length
          ? units
          : [
              {
                kind: 'documentation' as const,
                title: change.path,
                content: content.slice(0, 4000),
                startLine: 1,
                endLine: content.split('\n').length,
                contentHash: fileHash,
              },
            ];
        for (const unit of effectiveUnits) {
          if (unit.kind === 'symbol' && unit.symbol)
            await client.query(
              `INSERT INTO project_knowledge.code_symbols
            (project_id,snapshot_id,file_id,qualified_name,symbol_kind,start_line,end_line) VALUES($1,$2,$3,$4,$5,$6,$7)`,
              [
                projectRow.project_id,
                snapshot.id,
                file.id,
                unit.symbol,
                unit.kind,
                unit.startLine,
                unit.endLine,
              ],
            );
          const metadata = {
            path: change.path.replace(/\\/gu, '/'),
            ...(unit.symbol ? { symbol: unit.symbol } : {}),
            ...(unit.endpoint ? { endpoint: unit.endpoint } : {}),
            ...(unit.schemaTable ? { schema_table: unit.schemaTable } : {}),
            ...(unit.heading ? { heading: unit.heading } : {}),
            lines: { start: unit.startLine, end: unit.endLine },
            citation: `${change.path}:${unit.startLine}`,
          };
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO project_knowledge.search_chunks
            (project_id,snapshot_id,worktree_id,kind,title,content,content_hash,token_count,metadata)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [
              projectRow.project_id,
              snapshot.id,
              worktree.id,
              unit.kind,
              unit.title,
              unit.content,
              unit.contentHash,
              countSerializedTokens(unit.content),
              metadata,
            ],
          );
          await client.query(
            `INSERT INTO project_knowledge.outbox_jobs(project_id,job_type,payload)
            VALUES($1,'embed_chunk',$2) ON CONFLICT DO NOTHING`,
            [projectRow.project_id, { chunkId: inserted.rows[0]!.id }],
          );
        }
        indexedFiles++;
      }
      if (previous) {
        await client.query(
          `INSERT INTO project_knowledge.documentation_freshness
           (project_id,item_id,knowledge_version_id,worktree_id,snapshot_id,state,reason,checked_at)
           SELECT df.project_id,df.item_id,df.knowledge_version_id,df.worktree_id,$3,df.state,
             'Unchanged source locators inherited from previous snapshot',now()
           FROM project_knowledge.documentation_freshness df
           JOIN project_knowledge.knowledge_items i ON i.id=df.item_id
           JOIN project_knowledge.knowledge_versions v ON v.id=df.knowledge_version_id
             AND v.version=i.current_version
           WHERE df.project_id=$1 AND df.worktree_id=$2 AND df.snapshot_id=$4
             AND NOT EXISTS (
               SELECT 1 FROM project_knowledge.source_evidence e
               WHERE e.item_id=df.item_id AND e.knowledge_version_id=df.knowledge_version_id
                 AND e.source_path=ANY($5::text[])
             )
           ON CONFLICT(item_id,knowledge_version_id,worktree_id,snapshot_id) DO NOTHING`,
          [
            projectRow.project_id,
            worktree.id,
            snapshot.id,
            previous.id,
            changedPaths,
          ],
        );
      }
      await client.query(
        `WITH target_evidence AS (
           SELECT e.* FROM project_knowledge.source_evidence e
           JOIN project_knowledge.knowledge_items i ON i.id=e.item_id
           JOIN project_knowledge.knowledge_versions v ON v.id=e.knowledge_version_id
             AND v.version=i.current_version
           WHERE e.project_id=$1 AND e.knowledge_version_id IS NOT NULL
             AND ($5::boolean OR e.source_path=ANY($4::text[]))
         ), evaluated AS (
           SELECT e.item_id,e.knowledge_version_id,
             CASE WHEN current_chunk.content_hash IS NULL THEN 'missing'
                  WHEN current_chunk.content_hash=e.source_hash THEN 'current'
                  ELSE 'stale' END AS evidence_state
           FROM target_evidence e
           LEFT JOIN LATERAL (
             SELECT CASE WHEN e.locator_type IN ('path','migration','test') THEN source_file.source_hash
                    ELSE c.content_hash END AS content_hash
             FROM project_knowledge.code_files source_file
             LEFT JOIN project_knowledge.search_chunks c
               ON c.snapshot_id=source_file.snapshot_id
               AND c.metadata->>'path'=source_file.repo_relative_path
             WHERE source_file.snapshot_id=$3 AND source_file.repo_relative_path=e.source_path
               AND (e.locator_type IN ('path','migration','test') OR
                 CASE e.locator_type
                   WHEN 'symbol' THEN c.metadata->>'symbol'
                   WHEN 'endpoint' THEN c.metadata->>'endpoint'
                   WHEN 'table' THEN c.metadata->>'schema_table'
                   ELSE NULL
                 END=e.source_ref)
             ORDER BY (CASE WHEN e.locator_type IN ('path','migration','test') THEN source_file.source_hash
                       ELSE c.content_hash END=e.source_hash) DESC,c.id LIMIT 1
           ) current_chunk ON true
         ), reduced AS (
           SELECT item_id,knowledge_version_id,
             CASE WHEN bool_or(evidence_state='missing') THEN 'missing'
                  WHEN bool_or(evidence_state='stale') THEN 'stale'
                  ELSE 'current' END AS state
           FROM evaluated GROUP BY item_id,knowledge_version_id
         )
         INSERT INTO project_knowledge.documentation_freshness
           (project_id,item_id,knowledge_version_id,worktree_id,snapshot_id,state,reason)
         SELECT $1,item_id,knowledge_version_id,$2,$3,state,
           CASE state WHEN 'current' THEN 'All evidence hashes match'
             WHEN 'missing' THEN 'One or more source locators are missing'
             ELSE 'One or more source locator hashes changed' END
         FROM reduced
         ON CONFLICT(item_id,knowledge_version_id,worktree_id,snapshot_id) DO UPDATE SET
           state=EXCLUDED.state,reason=EXCLUDED.reason,checked_at=now()`,
        [
          projectRow.project_id,
          worktree.id,
          snapshot.id,
          changedPaths,
          !previous,
        ],
      );
      await client.query(
        `INSERT INTO project_knowledge.documentation_freshness
         (project_id,item_id,knowledge_version_id,worktree_id,snapshot_id,state,reason)
         SELECT i.project_id,i.id,v.id,$2,$3,'unverified','Current knowledge version has no source evidence'
         FROM project_knowledge.knowledge_items i
         JOIN project_knowledge.knowledge_versions v ON v.item_id=i.id AND v.version=i.current_version
         WHERE i.project_id=$1 AND i.superseded_by IS NULL
           AND NOT EXISTS (SELECT 1 FROM project_knowledge.source_evidence e WHERE e.knowledge_version_id=v.id)
         ON CONFLICT(item_id,knowledge_version_id,worktree_id,snapshot_id) DO UPDATE SET
           state='unverified',reason=EXCLUDED.reason,checked_at=now()`,
        [projectRow.project_id, worktree.id, snapshot.id],
      );
      if (changedPaths.length)
        await client.query(
          `UPDATE project_knowledge.task_file_rollups rollup SET
             final_source_hash=files.source_hash
           FROM project_knowledge.code_files files
           WHERE rollup.project_id=$1 AND rollup.worktree_id=$2
             AND files.snapshot_id=$3 AND files.repo_relative_path=rollup.repo_relative_path
             AND rollup.repo_relative_path=ANY($4::text[])`,
          [projectRow.project_id, worktree.id, snapshot.id, changedPaths],
        );
      await client.query(
        `UPDATE project_knowledge.source_snapshots SET state='superseded'
        WHERE project_id=$1 AND worktree_id=$2 AND state='active'`,
        [projectRow.project_id, worktree.id],
      );
      await client.query(
        `UPDATE project_knowledge.source_snapshots SET state='active',activated_at=now() WHERE id=$1`,
        [snapshot.id],
      );
      await client.query(
        `UPDATE project_knowledge.worktrees SET branch=$2,head_commit=$3,dirty_hash=$4,dirty_paths=$5,last_seen_at=now() WHERE id=$1`,
        [
          worktree.id,
          fingerprint.branch,
          fingerprint.head,
          fingerprint.dirtyHash,
          currentDirty,
        ],
      );
      await client.query('COMMIT');
      return { changed: true, snapshotId: snapshot.id, indexedFiles };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async syncWorktrees(project: WorkerProject): Promise<{
    registered: number;
    unmanaged: number;
    removed: number;
    paths: string[];
  }> {
    const projectRow = (
      await this.pool.query<{ project_id: string; repository_id: string }>(
        `SELECT p.project_id,r.id AS repository_id FROM project_knowledge.projects p
      JOIN project_knowledge.repositories r ON r.project_id=p.project_id WHERE p.project_key=$1 AND r.root_path=$2`,
        [project.projectKey, path.resolve(project.repositoryPath)],
      )
    ).rows[0];
    if (!projectRow)
      throw new Error(
        'Project must be reconciled before worktrees are synchronized',
      );
    const registered = await listRegisteredWorktrees(project.repositoryPath);
    const registeredPaths = new Set(
      registered.map((item) => path.resolve(item.path).toLowerCase()),
    );
    for (const item of registered) {
      const fingerprint = await fingerprintWorktree(item.path);
      await this.pool.query(
        `INSERT INTO project_knowledge.worktrees(project_id,repository_id,path,branch,head_commit,dirty_hash,dirty_paths,registered)
        VALUES($1,$2,$3,$4,$5,$6,$7,true) ON CONFLICT(project_id,path) DO UPDATE SET branch=EXCLUDED.branch,head_commit=EXCLUDED.head_commit,
        dirty_hash=EXCLUDED.dirty_hash,dirty_paths=EXCLUDED.dirty_paths,registered=true,last_seen_at=now()`,
        [
          projectRow.project_id,
          projectRow.repository_id,
          path.resolve(item.path),
          item.branch,
          item.head,
          fingerprint.dirtyHash,
          dirtyPaths(fingerprint.status),
        ],
      );
    }
    const removed = await deactivateMissingWorktrees(
      this.pool,
      projectRow.project_id,
      projectRow.repository_id,
      [...registeredPaths],
    );
    const worktreeRoot = path.join(project.repositoryPath, '.worktrees');
    const directories = await readdir(worktreeRoot, {
      withFileTypes: true,
    }).catch(() => []);
    let unmanaged = 0;
    for (const entry of directories) {
      if (!entry.isDirectory()) continue;
      const candidate = path.resolve(worktreeRoot, entry.name);
      if (registeredPaths.has(candidate.toLowerCase())) continue;
      unmanaged++;
      await this.pool.query(
        `INSERT INTO project_knowledge.worktrees(project_id,repository_id,path,branch,head_commit,dirty_hash,registered)
        VALUES($1,$2,$3,$4,$5,'unmanaged',false) ON CONFLICT(project_id,path) DO UPDATE SET registered=false,last_seen_at=now()`,
        [
          projectRow.project_id,
          projectRow.repository_id,
          candidate,
          entry.name,
          'unknown',
        ],
      );
    }
    return {
      registered: registered.length,
      unmanaged,
      removed: removed.length,
      paths: registered.map((item) => path.resolve(item.path)),
    };
  }

  async importLegacy(project: WorkerProject): Promise<number> {
    const notes = await inventoryLegacyNotes(project.vaultPath);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const projectId = (
        await client.query<{ project_id: string }>(
          'SELECT project_id FROM project_knowledge.projects WHERE project_key=$1',
          [project.projectKey],
        )
      ).rows[0]?.project_id;
      if (!projectId)
        throw new Error(
          'Project must be reconciled before importing its vault',
        );
      for (const note of notes)
        await client.query(
          `INSERT INTO project_knowledge.legacy_sources
        (project_id,original_path,raw_hash,size_bytes,modified_at,frontmatter,outbound_links,body_markdown,content_omitted_reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(project_id,original_path) DO UPDATE SET
        raw_hash=EXCLUDED.raw_hash,size_bytes=EXCLUDED.size_bytes,modified_at=EXCLUDED.modified_at,
        frontmatter=EXCLUDED.frontmatter,outbound_links=EXCLUDED.outbound_links,body_markdown=EXCLUDED.body_markdown,
        content_omitted_reason=EXCLUDED.content_omitted_reason`,
          [
            projectId,
            note.originalPath,
            note.rawHash,
            note.sizeBytes,
            note.modifiedAt,
            note.frontmatter,
            note.outboundLinks,
            note.bodyMarkdown ?? null,
            note.contentOmittedReason ?? null,
          ],
        );
      await client.query('COMMIT');
      return notes.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async normalizeLegacyDelivery(project: WorkerProject): Promise<number> {
    const notes = (await inventoryLegacyNotes(project.vaultPath)).filter(
      (note) => note.originalPath.startsWith('04 - Plans & Specs/'),
    );
    const projectRow = (
      await this.pool.query<{ project_id: string; db_revision: number }>(
        'SELECT project_id,db_revision FROM project_knowledge.projects WHERE project_key=$1',
        [project.projectKey],
      )
    ).rows[0];
    if (!projectRow)
      throw new Error(
        'Project must be reconciled before legacy delivery normalization',
      );
    const store = new PgKnowledgeStore(this.pool as never);
    let revision = Number(projectRow.db_revision);
    let changed = 0;
    for (const note of notes) {
      const title =
        typeof note.frontmatter.title === 'string'
          ? note.frontmatter.title
          : path
              .basename(note.originalPath, '.md')
              .replace(/^\d{4}-\d{2}-\d{2}-/u, '')
              .replaceAll('-', ' ');
      const status = deliveryStatus(note.frontmatter.status);
      const verification = 'unverified';
      const stableKey = `legacy-work:${note.originalPath}`;
      const body = `Source: \`${note.originalPath}\`\n\n${
        note.bodyMarkdown
          ?.replace(/^---[\s\S]*?---\s*/u, '')
          .split(/\n\s*\n/u)
          .find(Boolean)
          ?.slice(0, 1200) ?? 'Summary requires review.'
      }`;
      const existing = (
        await this.pool.query<{
          id: string;
          current_version: number;
          canonical_hash: string;
        }>(
          `SELECT i.id,i.current_version,v.canonical_hash FROM project_knowledge.knowledge_items i
        JOIN project_knowledge.knowledge_versions v ON v.item_id=i.id AND v.version=i.current_version WHERE i.project_id=$1 AND i.stable_key=$2`,
          [projectRow.project_id, stableKey],
        )
      ).rows[0];
      const expected = canonicalHash({
        kind: 'work_item',
        title,
        bodyMarkdown: body,
        properties: { sourcePath: note.originalPath, sourceHash: note.rawHash },
        deliveryStatus: status,
        verificationStatus: verification,
        domain: null,
        service: null,
      });
      let itemId = existing?.id;
      if (existing?.canonical_hash !== expected) {
        const result = await store.writeProjectKnowledge({
          projectKey: project.projectKey,
          actor: 'legacy-normalizer',
          expectedProjectRevision: revision,
          changes: [
            {
              operation: existing ? 'patch' : 'create',
              ...(existing
                ? { expectedVersion: existing.current_version }
                : {}),
              item: {
                ...(existing ? { id: existing.id } : {}),
                stableKey,
                kind: 'work_item',
                title,
                bodyMarkdown: body,
                deliveryStatus: status,
                verificationStatus: verification,
                properties: {
                  sourcePath: note.originalPath,
                  sourceHash: note.rawHash,
                },
              },
            },
          ],
        });
        revision = result.dbRevision;
        itemId = result.changes[0]!.itemId;
        changed++;
      }
      if (itemId)
        await this.pool.query(
          `INSERT INTO project_knowledge.work_items(project_id,item_id,status,verification_status)
        VALUES($1,$2,$3,$4) ON CONFLICT(item_id) DO UPDATE SET status=EXCLUDED.status,verification_status=EXCLUDED.verification_status`,
          [projectRow.project_id, itemId, status, verification],
        );
    }
    return changed;
  }

  async syncCanonicalDocuments(project: WorkerProject): Promise<number> {
    const documents = [
      {
        path: 'docs/architecture.md',
        stableKey: 'architecture:overview',
        kind: 'architecture',
        title: 'Architecture Overview',
      },
      {
        path: 'docs/services.md',
        stableKey: 'architecture:services',
        kind: 'service',
        title: 'Service Map',
      },
      {
        path: 'docs/database-schema.md',
        stableKey: 'database:reference',
        kind: 'database_reference',
        title: 'Database Schema Reference',
      },
      {
        path: 'docs/api-contracts.md',
        stableKey: 'api:reference',
        kind: 'api_reference',
        title: 'API Contract Reference',
      },
    ];
    const projectRow = (
      await this.pool.query<{ db_revision: number; snapshot_id: string }>(
        `SELECT p.db_revision,s.id AS snapshot_id
         FROM project_knowledge.projects p
         JOIN LATERAL (
           SELECT id FROM project_knowledge.source_snapshots
           WHERE project_id=p.project_id AND state='active'
           ORDER BY activated_at DESC LIMIT 1
         ) s ON true WHERE p.project_key=$1`,
        [project.projectKey],
      )
    ).rows[0];
    if (!projectRow)
      throw new Error(
        'Project must be reconciled before canonical documents are synchronized',
      );
    const store = new PgKnowledgeStore(this.pool as never);
    let revision = Number(projectRow.db_revision);
    let changed = 0;
    for (const document of documents) {
      const body = await readFile(
        path.join(project.repositoryPath, document.path),
        'utf8',
      ).catch(() => undefined);
      if (!body) continue;
      const existing = (
        await this.pool.query<{
          id: string;
          current_version: number;
          canonical_hash: string;
          has_evidence: boolean;
        }>(
          `
        SELECT i.id,i.current_version,v.canonical_hash,
          EXISTS(SELECT 1 FROM project_knowledge.source_evidence e WHERE e.knowledge_version_id=v.id) AS has_evidence
        FROM project_knowledge.knowledge_items i
        JOIN project_knowledge.knowledge_versions v ON v.item_id=i.id AND v.version=i.current_version
        JOIN project_knowledge.projects p ON p.project_id=i.project_id
        WHERE p.project_key=$1 AND i.stable_key=$2`,
          [project.projectKey, document.stableKey],
        )
      ).rows[0];
      const expected = canonicalHash({
        kind: document.kind,
        title: document.title,
        bodyMarkdown: body,
        properties: { sourcePath: document.path },
        deliveryStatus: null,
        verificationStatus: 'source_verified',
        domain: null,
        service: null,
      });
      if (existing?.canonical_hash === expected && existing.has_evidence)
        continue;
      const evidenceChunk = (
        await this.pool.query<{ id: string }>(
          `SELECT id FROM project_knowledge.search_chunks
           WHERE snapshot_id=$1 AND active AND metadata->>'path'=$2
           ORDER BY id LIMIT 1`,
          [projectRow.snapshot_id, document.path],
        )
      ).rows[0];
      if (!evidenceChunk) continue;
      const result = await store.writeProjectKnowledge({
        projectKey: project.projectKey,
        actor: 'knowledge-worker',
        expectedProjectRevision: revision,
        changes: [
          {
            operation: existing ? 'patch' : 'create',
            ...(existing ? { expectedVersion: existing.current_version } : {}),
            evidence: [
              {
                snapshotId: projectRow.snapshot_id,
                ref: `chunk:${evidenceChunk.id}`,
                locatorType: 'path',
                required: true,
                verificationScope: 'required',
              },
            ],
            item: {
              ...(existing ? { id: existing.id } : {}),
              stableKey: document.stableKey,
              kind: document.kind,
              title: document.title,
              bodyMarkdown: body,
              verificationStatus: 'source_verified',
              properties: { sourcePath: document.path },
            },
          },
        ],
      });
      revision = result.dbRevision;
      changed++;
    }
    return changed;
  }

  async syncStructuredDocumentation(
    project: WorkerProject,
  ): Promise<{ tables: number; endpoints: number; sequences: number }> {
    const projectRow = (
      await this.pool.query<{ project_id: string; head_commit: string }>(
        `SELECT p.project_id,s.head_commit
      FROM project_knowledge.projects p LEFT JOIN LATERAL (SELECT head_commit FROM project_knowledge.source_snapshots
      WHERE project_id=p.project_id AND state='active' ORDER BY activated_at DESC LIMIT 1) s ON true WHERE p.project_key=$1`,
        [project.projectKey],
      )
    ).rows[0];
    if (!projectRow)
      throw new Error(
        'Project must be reconciled before structured documentation is synchronized',
      );
    const migrationRoot = path.join(project.repositoryPath, 'db');
    const migrationNames = (await readdir(migrationRoot).catch(() => []))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    const migrations = await Promise.all(
      migrationNames.map(async (name) =>
        parseDatabaseMigration(
          `db/${name}`,
          await readFile(path.join(migrationRoot, name), 'utf8'),
        ),
      ),
    );
    const apiMarkdown = await readFile(
      path.join(project.repositoryPath, 'docs/api-contracts.md'),
      'utf8',
    ).catch(() => '');
    const architectureMarkdown = await readFile(
      path.join(project.repositoryPath, 'docs/architecture.md'),
      'utf8',
    ).catch(() => '');
    const endpoints = parseApiContracts(apiMarkdown);
    const sequences = parseSequenceFlows(architectureMarkdown);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const table of [
        'documented_migrations',
        'documented_relationships',
        'documented_columns',
        'documented_tables',
        'documented_schemas',
        'physical_mappings',
      ])
        await client.query(
          `DELETE FROM project_knowledge.${table} WHERE project_id=$1`,
          [projectRow.project_id],
        );
      const tableIds = new Map<string, string>();
      for (
        let migrationIndex = 0;
        migrationIndex < migrations.length;
        migrationIndex++
      ) {
        const migration = migrations[migrationIndex]!;
        await client.query(
          `INSERT INTO project_knowledge.documented_migrations(project_id,path,source_hash,migration_order)
          VALUES($1,$2,$3,$4)`,
          [
            projectRow.project_id,
            migration.path,
            sourceHash(
              await readFile(
                path.join(project.repositoryPath, migration.path),
                'utf8',
              ),
            ),
            migrationIndex + 1,
          ],
        );
        for (const table of migration.tables) {
          const schemaId = (
            await client.query<{ id: string }>(
              `INSERT INTO project_knowledge.documented_schemas(project_id,name)
            VALUES($1,$2) ON CONFLICT(project_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
              [projectRow.project_id, table.schema],
            )
          ).rows[0]!.id;
          const owner = table.name.startsWith('billing_')
            ? 'Billing'
            : table.name.startsWith('catalog_')
              ? 'Catalog'
              : 'PlayNode Core';
          const tableId = (
            await client.query<{ id: string }>(
              `INSERT INTO project_knowledge.documented_tables(project_id,schema_id,name,owning_service,migration_path)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,schema_id,name) DO UPDATE SET migration_path=EXCLUDED.migration_path,owning_service=EXCLUDED.owning_service RETURNING id`,
              [
                projectRow.project_id,
                schemaId,
                table.name,
                owner,
                migration.path,
              ],
            )
          ).rows[0]!.id;
          tableIds.set(`${table.schema}.${table.name}`, tableId);
          for (let ordinal = 0; ordinal < table.columns.length; ordinal++) {
            const column = table.columns[ordinal]!;
            await client.query(
              `INSERT INTO project_knowledge.documented_columns(project_id,table_id,name,data_type,nullable,default_expression,ordinal)
              VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(table_id,name) DO UPDATE SET data_type=EXCLUDED.data_type,nullable=EXCLUDED.nullable,default_expression=EXCLUDED.default_expression,ordinal=EXCLUDED.ordinal`,
              [
                projectRow.project_id,
                tableId,
                column.name,
                column.type,
                column.nullable,
                column.default ?? null,
                ordinal + 1,
              ],
            );
          }
          await client.query(
            `INSERT INTO project_knowledge.physical_mappings(project_id,service,object_name,schema_name,table_name,access_mode)
            VALUES($1,$2,$3,$4,$5,'owner')`,
            [
              projectRow.project_id,
              owner,
              table.name,
              table.schema,
              table.name,
            ],
          );
        }
      }
      for (const migration of migrations)
        for (const table of migration.tables)
          for (const relation of table.relationships) {
            const sourceId = tableIds.get(`${table.schema}.${table.name}`);
            const targetId = tableIds.get(
              `${relation.targetSchema}.${relation.targetTable}`,
            );
            if (sourceId && targetId)
              await client.query(
                `INSERT INTO project_knowledge.documented_relationships
          (project_id,source_table_id,target_table_id,source_columns,target_columns,relationship_type) VALUES($1,$2,$3,$4,$5,'many_to_one')`,
                [
                  projectRow.project_id,
                  sourceId,
                  targetId,
                  [relation.sourceColumn],
                  [relation.targetColumn],
                ],
              );
          }
      for (const table of ['api_examples', 'api_endpoints', 'api_services'])
        await client.query(
          `DELETE FROM project_knowledge.${table} WHERE project_id=$1`,
          [projectRow.project_id],
        );
      const serviceIds = new Map<string, string>();
      for (const endpoint of endpoints) {
        let serviceId = serviceIds.get(endpoint.service);
        if (!serviceId) {
          serviceId = (
            await client.query<{ id: string }>(
              `INSERT INTO project_knowledge.api_services(project_id,service_key,title) VALUES($1,$2,$3) RETURNING id`,
              [
                projectRow.project_id,
                endpoint.service.toLowerCase().replace(/[^a-z0-9]+/gu, '-'),
                endpoint.service,
              ],
            )
          ).rows[0]!.id;
          serviceIds.set(endpoint.service, serviceId);
        }
        await client.query(
          `INSERT INTO project_knowledge.api_endpoints(project_id,api_service_id,method,route,description,auth,request_contract,response_contracts,idempotency,implementation_status,verified_git_revision)
          VALUES($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,$8,'documented',$9)`,
          [
            projectRow.project_id,
            serviceId,
            endpoint.method,
            endpoint.route,
            endpoint.description ||
              'Contract details require source expansion.',
            endpoint.auth,
            endpoint.responseSummary
              ? { summary: endpoint.responseSummary }
              : {},
            endpoint.idempotency ?? null,
            projectRow.head_commit,
          ],
        );
      }
      for (const table of [
        'sequence_steps',
        'sequence_participants',
        'sequence_flows',
      ])
        await client.query(
          `DELETE FROM project_knowledge.${table} WHERE project_id=$1`,
          [projectRow.project_id],
        );
      for (const flow of sequences) {
        const domainId = (
          await client.query<{ id: string }>(
            `INSERT INTO project_knowledge.domains(project_id,name)
          VALUES($1,$2) ON CONFLICT(project_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
            [projectRow.project_id, flow.domain],
          )
        ).rows[0]!.id;
        const flowId = (
          await client.query<{ id: string }>(
            `INSERT INTO project_knowledge.sequence_flows(project_id,domain_id,name,implementation_status)
          VALUES($1,$2,$3,$4) RETURNING id`,
            [projectRow.project_id, domainId, flow.name, flow.status],
          )
        ).rows[0]!.id;
        for (let i = 0; i < flow.participants.length; i++)
          await client.query(
            `INSERT INTO project_knowledge.sequence_participants(project_id,flow_id,participant_order,alias,label)
          VALUES($1,$2,$3,$4,$5)`,
            [
              projectRow.project_id,
              flowId,
              i + 1,
              flow.participants[i]!.alias,
              flow.participants[i]!.label,
            ],
          );
        for (let i = 0; i < flow.steps.length; i++)
          await client.query(
            `INSERT INTO project_knowledge.sequence_steps(project_id,flow_id,step_order,source_alias,target_alias,message,response)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              projectRow.project_id,
              flowId,
              i + 1,
              flow.steps[i]!.source,
              flow.steps[i]!.target,
              flow.steps[i]!.message,
              flow.steps[i]!.response,
            ],
          );
      }
      await client.query('COMMIT');
      return {
        tables: tableIds.size,
        endpoints: endpoints.length,
        sequences: sequences.length,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async processInbox(
    project: WorkerProject,
  ): Promise<{ imported: number; needsClarification: number }> {
    const inboxRoot = path.join(project.vaultPath, 'Inbox');
    const notes = await inventoryLegacyNotes(inboxRoot).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    const projectRow = (
      await this.pool.query<{ project_id: string; db_revision: number }>(
        'SELECT project_id,db_revision FROM project_knowledge.projects WHERE project_key=$1',
        [project.projectKey],
      )
    ).rows[0];
    if (!projectRow)
      throw new Error('Project must be reconciled before Inbox processing');
    const store = new PgKnowledgeStore(this.pool as never);
    let revision = Number(projectRow.db_revision);
    let imported = 0;
    let needsClarification = 0;
    for (const note of notes) {
      const relativePath = `Inbox/${note.originalPath}`;
      const seen = await this.pool.query(
        'SELECT 1 FROM project_knowledge.inbox_imports WHERE project_id=$1 AND relative_path=$2 AND source_hash=$3',
        [projectRow.project_id, relativePath, note.rawHash],
      );
      if (seen.rows.length) continue;
      const parsed = note.bodyMarkdown ? matter(note.bodyMarkdown) : undefined;
      const kind =
        typeof parsed?.data.kind === 'string' ? parsed.data.kind.trim() : '';
      const title =
        typeof parsed?.data.title === 'string' ? parsed.data.title.trim() : '';
      if (!kind || !title || !parsed) {
        await this.pool.query(
          `INSERT INTO project_knowledge.inbox_imports(project_id,relative_path,source_hash,state,error_message)
          VALUES($1,$2,$3,'needs_clarification',$4)`,
          [
            projectRow.project_id,
            relativePath,
            note.rawHash,
            'Inbox note requires kind and title frontmatter',
          ],
        );
        needsClarification++;
        continue;
      }
      const targetId =
        typeof parsed.data.target_id === 'string'
          ? parsed.data.target_id
          : undefined;
      const currentVersion = targetId
        ? Number(
            (
              await this.pool.query<{ current_version: number }>(
                'SELECT current_version FROM project_knowledge.knowledge_items WHERE project_id=$1 AND id=$2',
                [projectRow.project_id, targetId],
              )
            ).rows[0]?.current_version ?? 0,
          )
        : 0;
      const result = await store.writeProjectKnowledge({
        projectKey: project.projectKey,
        actor: 'obsidian-inbox',
        expectedProjectRevision: revision,
        changes: [
          {
            operation: targetId ? 'patch' : 'create',
            ...(currentVersion ? { expectedVersion: currentVersion } : {}),
            item: {
              ...(targetId ? { id: targetId } : {}),
              ...(typeof parsed.data.stable_key === 'string'
                ? { stableKey: parsed.data.stable_key }
                : {}),
              kind,
              title,
              bodyMarkdown: parsed.content.trim(),
              ...(typeof parsed.data.status === 'string'
                ? { deliveryStatus: parsed.data.status }
                : {}),
              verificationStatus:
                typeof parsed.data.verification === 'string'
                  ? parsed.data.verification
                  : 'unverified',
              ...(typeof parsed.data.domain === 'string'
                ? { domain: parsed.data.domain }
                : {}),
              ...(typeof parsed.data.service === 'string'
                ? { service: parsed.data.service }
                : {}),
            },
          },
        ],
      });
      revision = result.dbRevision;
      await this.pool.query(
        `INSERT INTO project_knowledge.inbox_imports(project_id,relative_path,source_hash,state,item_id)
        VALUES($1,$2,$3,'imported',$4)`,
        [
          projectRow.project_id,
          relativePath,
          note.rawHash,
          result.changes[0]!.itemId,
        ],
      );
      imported++;
    }
    return { imported, needsClarification };
  }

  async publishVault(
    project: WorkerProject,
  ): Promise<{ current: number; drifted: number }> {
    const projectRow = (
      await this.pool.query<{ project_id: string; db_revision: number }>(
        'SELECT project_id,db_revision FROM project_knowledge.projects WHERE project_key=$1',
        [project.projectKey],
      )
    ).rows[0];
    if (!projectRow)
      throw new Error('Project must be reconciled before publishing');
    const activeSnapshot = (
      await this.pool.query<{
        id: string;
        head_commit: string;
        dirty_hash: string | null;
      }>(
        `
      SELECT s.id,s.head_commit,s.dirty_hash FROM project_knowledge.source_snapshots s
      JOIN project_knowledge.worktrees w ON w.id=s.worktree_id
      WHERE s.project_id=$1 AND s.state='active' AND w.path=$2
      ORDER BY s.activated_at DESC LIMIT 1`,
        [projectRow.project_id, path.resolve(project.repositoryPath)],
      )
    ).rows[0];
    const architecture = (
      await this.pool.query<{
        title: string;
        body_markdown: string;
        kind: string;
      }>(
        `
      SELECT i.title,v.body_markdown,i.kind FROM project_knowledge.knowledge_items i
      JOIN project_knowledge.knowledge_versions v ON v.item_id=i.id AND v.version=i.current_version
      WHERE i.project_id=$1 AND i.superseded_by IS NULL AND i.kind=ANY($2::text[]) ORDER BY i.kind,i.title`,
        [projectRow.project_id, ['architecture', 'system_design', 'service']],
      )
    ).rows.map((row) => ({
      title: row.title,
      body: row.body_markdown,
      kind: row.kind,
    }));
    const workItems = (
      await this.pool.query<{
        title: string;
        status: string;
        verification_status: string;
        blocker: string | null;
        worktrees: string[];
      }>(
        `
      SELECT i.title,w.status,w.verification_status,w.blocker,
        COALESCE(array_agg(DISTINCT wt.branch||'@'||left(wt.head_commit,8)) FILTER(WHERE wt.id IS NOT NULL),'{}') AS worktrees
      FROM project_knowledge.work_items w JOIN project_knowledge.knowledge_items i ON i.id=w.item_id
      LEFT JOIN project_knowledge.worktree_links wl ON wl.work_item_id=w.id LEFT JOIN project_knowledge.worktrees wt ON wt.id=wl.worktree_id
      WHERE w.project_id=$1 GROUP BY i.title,w.status,w.verification_status,w.blocker ORDER BY w.status,i.title`,
        [projectRow.project_id],
      )
    ).rows.map((row) => ({
      title: row.title,
      status: row.status,
      verificationStatus: row.verification_status,
      ...(row.blocker ? { blocker: row.blocker } : {}),
      worktrees: row.worktrees,
    }));
    const worktrees = (
      await this.pool.query<{
        branch: string;
        head_commit: string;
        dirty_hash: string | null;
        registered: boolean;
        freshness: string;
      }>(
        `
      SELECT w.branch,w.head_commit,w.dirty_hash,w.registered,
        CASE WHEN s.head_commit=w.head_commit AND s.dirty_hash IS NOT DISTINCT FROM w.dirty_hash THEN 'current' ELSE 'stale' END AS freshness
      FROM project_knowledge.worktrees w LEFT JOIN LATERAL (SELECT head_commit,dirty_hash FROM project_knowledge.source_snapshots
        WHERE worktree_id=w.id AND state='active' ORDER BY activated_at DESC LIMIT 1) s ON true WHERE w.project_id=$1 ORDER BY w.path`,
        [projectRow.project_id],
      )
    ).rows.map((row) => ({
      branch: row.branch,
      head: row.head_commit,
      dirty: Boolean(row.dirty_hash),
      registered: row.registered,
      freshness: row.freshness,
    }));
    const endpoints = (
      await this.pool.query<{
        id: string;
        service: string;
        method: string;
        route: string;
        description: string;
        auth: unknown;
        request_contract: unknown;
        response_contracts: Record<string, unknown>;
        implementation_status: string;
        verified_git_revision: string | null;
      }>(
        `
      SELECT e.id,s.title AS service,e.method,e.route,e.description,e.auth,e.request_contract,e.response_contracts,
        e.implementation_status,e.verified_git_revision FROM project_knowledge.api_endpoints e
      JOIN project_knowledge.api_services s ON s.id=e.api_service_id WHERE e.project_id=$1 ORDER BY s.title,e.route,e.method`,
        [projectRow.project_id],
      )
    ).rows;
    const examples = (
      await this.pool.query<{
        endpoint_id: string;
        example_type: string;
        status_code: number | null;
        title: string;
        payload: unknown;
      }>(
        'SELECT endpoint_id,example_type,status_code,title,payload FROM project_knowledge.api_examples WHERE project_id=$1 ORDER BY endpoint_id,example_type,status_code',
        [projectRow.project_id],
      )
    ).rows;
    const sequenceRows = (
      await this.pool.query<{
        id: string;
        domain: string;
        name: string;
        status: string;
      }>(
        `
      SELECT f.id,d.name AS domain,f.name,f.implementation_status AS status FROM project_knowledge.sequence_flows f
      JOIN project_knowledge.domains d ON d.id=f.domain_id WHERE f.project_id=$1 ORDER BY d.name,f.name`,
        [projectRow.project_id],
      )
    ).rows;
    const participants = await this.pool.query<{
      flow_id: string;
      alias: string;
      label: string;
    }>(
      'SELECT flow_id,alias,label FROM project_knowledge.sequence_participants WHERE project_id=$1 ORDER BY participant_order',
      [projectRow.project_id],
    );
    const steps = await this.pool.query<{
      flow_id: string;
      source_alias: string;
      target_alias: string;
      message: string;
      response: boolean;
    }>(
      'SELECT flow_id,source_alias,target_alias,message,response FROM project_knowledge.sequence_steps WHERE project_id=$1 ORDER BY step_order',
      [projectRow.project_id],
    );
    const schemaRows = await this.pool.query<{
      id: string;
      name: string;
      description: string | null;
    }>(
      'SELECT id,name,description FROM project_knowledge.documented_schemas WHERE project_id=$1 ORDER BY name',
      [projectRow.project_id],
    );
    const tableRows = await this.pool.query<{
      id: string;
      schema_id: string;
      name: string;
      description: string | null;
      owning_service: string | null;
      migration_path: string | null;
    }>(
      'SELECT id,schema_id,name,description,owning_service,migration_path FROM project_knowledge.documented_tables WHERE project_id=$1 ORDER BY name',
      [projectRow.project_id],
    );
    const columnRows = await this.pool.query<{
      table_id: string;
      name: string;
      data_type: string;
      nullable: boolean;
      default_expression: string | null;
    }>(
      'SELECT table_id,name,data_type,nullable,default_expression FROM project_knowledge.documented_columns WHERE project_id=$1 ORDER BY ordinal',
      [projectRow.project_id],
    );
    const mappingRows = await this.pool.query<{
      domain: string | null;
      service: string | null;
      object_name: string | null;
      code_symbol: string | null;
      schema_name: string;
      table_name: string;
      column_name: string | null;
      access_mode: string;
    }>(
      'SELECT domain,service,object_name,code_symbol,schema_name,table_name,column_name,access_mode FROM project_knowledge.physical_mappings WHERE project_id=$1 ORDER BY schema_name,table_name,column_name NULLS FIRST,service',
      [projectRow.project_id],
    );
    const decisions = (
      await this.pool.query<{
        title: string;
        body_markdown: string;
        delivery_status: string | null;
      }>(
        `
      SELECT i.title,v.body_markdown,i.delivery_status FROM project_knowledge.knowledge_items i
      JOIN project_knowledge.knowledge_versions v ON v.item_id=i.id AND v.version=i.current_version
      WHERE i.project_id=$1 AND i.kind='decision' AND i.superseded_by IS NULL ORDER BY i.title`,
        [projectRow.project_id],
      )
    ).rows;
    const projections = await this.pool.query<{
      relative_path: string;
      state: string;
      db_revision: number;
    }>(
      'SELECT relative_path,state,db_revision FROM project_knowledge.note_projections WHERE project_id=$1 ORDER BY relative_path',
      [projectRow.project_id],
    );
    const freshnessRows = activeSnapshot
      ? await this.pool.query<{ state: string; count: number }>(
          `SELECT state,count(DISTINCT item_id)::int AS count
           FROM project_knowledge.documentation_freshness freshness
           JOIN project_knowledge.knowledge_items item ON item.id=freshness.item_id
           WHERE freshness.project_id=$1 AND freshness.snapshot_id=$2
             AND item.kind=ANY($3::text[])
           GROUP BY state`,
          [
            projectRow.project_id,
            activeSnapshot.id,
            [
              'architecture',
              'architecture_boundary',
              'system_design',
              'service',
              'api_reference',
              'api_contract',
              'database_reference',
              'database_schema',
              'database_dictionary',
              'permission',
              'permissions',
              'runbook',
              'operational_runbook',
            ],
          ],
        )
      : { rows: [] };
    const freshnessCounts = new Map(
      freshnessRows.rows.map((row) => [row.state, Number(row.count)]),
    );
    const taskRows = await this.pool.query<{
      id: string;
      agent: 'codex' | 'claude';
      external_task_id: string;
      task_name: string;
      status: string;
      worktree_path: string;
      branch: string;
      start_revision: string | null;
      current_revision: string;
      documentation_gate: string;
      started_at: Date;
      last_seen_at: Date;
    }>(
      `SELECT t.id,t.agent,t.external_task_id,t.task_name,t.status,
         w.path AS worktree_path,w.branch,start_snapshot.head_commit AS start_revision,
         w.head_commit AS current_revision,
         CASE WHEN EXISTS (
           SELECT 1 FROM project_knowledge.task_file_rollups rollup
           JOIN project_knowledge.source_evidence evidence
             ON evidence.project_id=rollup.project_id
             AND evidence.source_path=rollup.repo_relative_path AND evidence.required
           JOIN project_knowledge.source_snapshots active_snapshot
             ON active_snapshot.worktree_id=rollup.worktree_id AND active_snapshot.state='active'
           LEFT JOIN project_knowledge.documentation_freshness freshness
             ON freshness.item_id=evidence.item_id
             AND freshness.knowledge_version_id=evidence.knowledge_version_id
             AND freshness.worktree_id=rollup.worktree_id
             AND freshness.snapshot_id=active_snapshot.id
           WHERE rollup.task_id=t.id AND rollup.changed_by_task
             AND COALESCE(freshness.state,'unverified')<>'current'
         ) THEN 'blocked' ELSE 'current' END AS documentation_gate,
         t.started_at,t.last_seen_at
       FROM project_knowledge.agent_tasks t
       JOIN project_knowledge.worktrees w ON w.id=t.worktree_id
       LEFT JOIN project_knowledge.source_snapshots start_snapshot ON start_snapshot.id=t.start_snapshot_id
       WHERE t.project_id=$1 ORDER BY t.last_seen_at DESC LIMIT 25`,
      [projectRow.project_id],
    );
    const taskIds = taskRows.rows.map((task) => task.id);
    const taskFileRows = taskIds.length
      ? await this.pool.query<{
          task_id: string;
          repo_relative_path: string;
          actions: string[];
          access_count: number;
          first_access_at: Date;
          last_access_at: Date;
          changed_by_task: boolean;
        }>(
          `SELECT task_id,repo_relative_path,actions,access_count,first_access_at,last_access_at,changed_by_task
           FROM (
             SELECT rollup.*,row_number() OVER(PARTITION BY task_id ORDER BY last_access_at DESC) AS task_rank
             FROM project_knowledge.task_file_rollups rollup WHERE task_id=ANY($1::uuid[])
           ) ranked WHERE task_rank<=50 ORDER BY task_id,last_access_at DESC`,
          [taskIds],
        )
      : { rows: [] };
    const taskDocumentationRows = taskIds.length
      ? await this.pool.query<{
          task_id: string;
          item_id: string;
          title: string;
          current_version: number;
          state: string;
        }>(
          `SELECT DISTINCT task.id AS task_id,item.id AS item_id,item.title,item.current_version,
             COALESCE(freshness.state,'unverified') AS state
           FROM project_knowledge.agent_tasks task
           JOIN project_knowledge.task_file_rollups rollup ON rollup.task_id=task.id AND rollup.changed_by_task
           JOIN project_knowledge.source_evidence evidence
             ON evidence.project_id=rollup.project_id AND evidence.source_path=rollup.repo_relative_path
           JOIN project_knowledge.knowledge_items item ON item.id=evidence.item_id
           LEFT JOIN LATERAL (
             SELECT state FROM project_knowledge.documentation_freshness
             WHERE item_id=evidence.item_id AND knowledge_version_id=evidence.knowledge_version_id
               AND worktree_id=rollup.worktree_id
             ORDER BY checked_at DESC LIMIT 1
           ) freshness ON true
           WHERE task.id=ANY($1::uuid[]) ORDER BY task.id,item.title`,
          [taskIds],
        )
      : { rows: [] };
    const taskEvidenceRows = taskIds.length
      ? await this.pool.query<{
          task_id: string;
          locator_type: string;
          source_path: string;
          source_ref: string | null;
          source_hash: string;
        }>(
          `SELECT task.id AS task_id,evidence.locator_type,evidence.source_path,
             evidence.source_ref,evidence.source_hash
           FROM project_knowledge.agent_tasks task
           JOIN project_knowledge.knowledge_versions version
             ON version.project_id=task.project_id AND version.task_id=task.external_task_id
           JOIN project_knowledge.source_evidence evidence
             ON evidence.knowledge_version_id=version.id
           WHERE task.id=ANY($1::uuid[])
           ORDER BY task.id,evidence.locator_type,evidence.source_path,evidence.source_ref`,
          [taskIds],
        )
      : { rows: [] };
    const legacyCount = Number(
      (
        await this.pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM project_knowledge.legacy_sources WHERE project_id=$1',
          [projectRow.project_id],
        )
      ).rows[0]?.count ?? 0,
    );
    const legacyRows = (
      await this.pool.query<{
        id: string;
        original_path: string;
        raw_hash: string;
      }>(
        'SELECT id,original_path,raw_hash FROM project_knowledge.legacy_sources WHERE project_id=$1 ORDER BY original_path',
        [projectRow.project_id],
      )
    ).rows;
    const domainSync = await buildDomainSyncReport(this.pool, {
      projectId: projectRow.project_id,
      repositoryPath: project.repositoryPath,
      databaseRevision: Number(projectRow.db_revision),
    });
    const data: ProjectViewData = {
      projectId: projectRow.project_id,
      projectKey: project.projectKey,
      dbRevision: Number(projectRow.db_revision),
      gitRevision: activeSnapshot?.head_commit ?? '',
      architecture,
      workItems,
      worktrees,
      endpoints: endpoints.map((endpoint) => ({
        service: endpoint.service,
        method: endpoint.method,
        route: endpoint.route,
        description: endpoint.description,
        auth: endpoint.auth,
        request: endpoint.request_contract,
        responses: endpoint.response_contracts,
        examples: examples
          .filter((example) => example.endpoint_id === endpoint.id)
          .map((example) => ({
            type: example.example_type,
            ...(example.status_code ? { statusCode: example.status_code } : {}),
            title: example.title,
            payload: example.payload,
          })),
        status: endpoint.implementation_status,
        source: 'docs/api-contracts.md',
        ...(endpoint.verified_git_revision
          ? { gitRevision: endpoint.verified_git_revision }
          : {}),
      })),
      sequences: sequenceRows.map((flow) => ({
        domain: flow.domain,
        name: flow.name,
        status: flow.status,
        participants: participants.rows.filter(
          (row) => row.flow_id === flow.id,
        ),
        steps: steps.rows
          .filter((row) => row.flow_id === flow.id)
          .map((row) => ({
            source: row.source_alias,
            target: row.target_alias,
            message: row.message,
            response: row.response,
          })),
      })),
      schemas: schemaRows.rows.map((schema) => ({
        name: schema.name,
        ...(schema.description ? { description: schema.description } : {}),
        tables: tableRows.rows
          .filter((table) => table.schema_id === schema.id)
          .map((table) => ({
            name: table.name,
            ...(table.description ? { description: table.description } : {}),
            ...(table.owning_service ? { owner: table.owning_service } : {}),
            ...(table.migration_path
              ? { migration: table.migration_path }
              : {}),
            columns: columnRows.rows
              .filter((column) => column.table_id === table.id)
              .map((column) => ({
                name: column.name,
                type: column.data_type,
                nullable: column.nullable,
                ...(column.default_expression
                  ? { default: column.default_expression }
                  : {}),
              })),
          })),
      })),
      mappings: mappingRows.rows.map((row) => ({
        ...(row.domain ? { domain: row.domain } : {}),
        ...(row.service ? { service: row.service } : {}),
        ...(row.object_name ? { object: row.object_name } : {}),
        ...(row.code_symbol ? { symbol: row.code_symbol } : {}),
        target: `${row.schema_name}.${row.table_name}${row.column_name ? `.${row.column_name}` : ''}`,
        access: row.access_mode,
      })),
      decisions: decisions.map((row) => ({
        title: row.title,
        body: row.body_markdown,
        ...(row.delivery_status ? { status: row.delivery_status } : {}),
      })),
      projections: projections.rows.map((row) => ({
        path: row.relative_path,
        state: row.state,
        revision: Number(row.db_revision),
      })),
      documentationFreshness: {
        current: freshnessCounts.get('current') ?? 0,
        possiblyStale: freshnessCounts.get('possibly_stale') ?? 0,
        stale: freshnessCounts.get('stale') ?? 0,
        missing: freshnessCounts.get('missing') ?? 0,
        unverified: freshnessCounts.get('unverified') ?? 0,
      },
      agentTasks: taskRows.rows.map((task) => ({
        agent: task.agent,
        taskId: task.external_task_id,
        taskName: task.task_name,
        status: task.status,
        worktree: task.worktree_path,
        branch: task.branch,
        startRevision: task.start_revision ?? 'unindexed',
        currentRevision: task.current_revision,
        documentationGate: task.documentation_gate,
        startedAt: task.started_at.toISOString(),
        lastActivityAt: task.last_seen_at.toISOString(),
        files: taskFileRows.rows
          .filter((file) => file.task_id === task.id)
          .map((file) => ({
            path: file.repo_relative_path,
            actions: file.actions,
            accessCount: Number(file.access_count),
            firstAccessAt: file.first_access_at.toISOString(),
            lastAccessAt: file.last_access_at.toISOString(),
            changed: file.changed_by_task,
          })),
        documentation: taskDocumentationRows.rows
          .filter((item) => item.task_id === task.id)
          .map((item) => ({
            ref: `knowledge:${item.item_id}:v${item.current_version}`,
            title: item.title,
            state: item.state,
          })),
        verificationEvidence: taskEvidenceRows.rows
          .filter((item) => item.task_id === task.id)
          .map((item) => ({
            locatorType: item.locator_type,
            path: item.source_path,
            ...(item.source_ref ? { sourceRef: item.source_ref } : {}),
            sourceHash: item.source_hash,
          })),
      })),
      legacyCount,
      legacy: legacyRows.map((row) => ({
        id: row.id,
        originalPath: row.original_path,
        rawHash: row.raw_hash,
      })),
      ...(domainSync ? { domainSync } : {}),
    };
    let current = 0;
    let drifted = 0;
    const views = buildProjectViews(data);
    for (const view of views) {
      const existing = (
        await this.pool.query<{
          id: string;
          last_published_hash: string | null;
          state: string;
          observed_hash: string | null;
          projection_hash: string;
          preserved_path: string | null;
        }>(
          `SELECT projection.id,projection.last_published_hash,projection.state,
             projection.observed_hash,projection.projection_hash,
             (SELECT conflict.preserved_path FROM project_knowledge.projection_conflicts conflict
              WHERE conflict.projection_id=projection.id AND conflict.resolved_at IS NULL
              ORDER BY conflict.created_at DESC LIMIT 1) AS preserved_path
           FROM project_knowledge.note_projections projection
           WHERE projection.project_id=$1 AND projection.view_id=$2`,
          [projectRow.project_id, view.viewId],
        )
      ).rows[0];
      const rendered =
        view.format === 'json'
          ? view.body
          : renderManagedNote({
              viewId: view.viewId,
              projectId: projectRow.project_id,
              viewType: view.viewType,
              dbRevision: Number(projectRow.db_revision),
              gitRevision: activeSnapshot?.head_commit,
              metadata: view.metadata,
              body: view.body,
            });
      const desiredHash = projectionHash(rendered);
      const result = await publishProjection(
        project.vaultPath,
        view.relativePath,
        rendered,
        existing?.last_published_hash ?? undefined,
        existing?.state === 'drifted' &&
          existing.observed_hash &&
          existing.preserved_path
          ? {
              desiredHash: existing.projection_hash,
              observedHash: existing.observed_hash,
              preservedPath: existing.preserved_path,
            }
          : undefined,
      );
      const projection = (
        await this.pool.query<{ id: string }>(
          `INSERT INTO project_knowledge.note_projections
        (project_id,view_id,relative_path,db_revision,canonical_hash,projection_hash,observed_hash,last_published_hash,state,worktree_id,source_snapshot_id)
        VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10) ON CONFLICT(project_id,view_id) DO UPDATE SET
        relative_path=EXCLUDED.relative_path,db_revision=EXCLUDED.db_revision,canonical_hash=EXCLUDED.canonical_hash,
        projection_hash=EXCLUDED.projection_hash,observed_hash=EXCLUDED.observed_hash,
        last_published_hash=CASE WHEN EXCLUDED.state='current' THEN EXCLUDED.projection_hash ELSE project_knowledge.note_projections.last_published_hash END,
        worktree_id=CASE WHEN EXCLUDED.state='current' THEN EXCLUDED.worktree_id ELSE project_knowledge.note_projections.worktree_id END,
        source_snapshot_id=CASE WHEN EXCLUDED.state='current' THEN EXCLUDED.source_snapshot_id ELSE project_knowledge.note_projections.source_snapshot_id END,
        state=EXCLUDED.state,updated_at=now() RETURNING id`,
          [
            projectRow.project_id,
            view.viewId,
            view.relativePath,
            projectRow.db_revision,
            desiredHash,
            result.observedHash,
            result.state === 'current'
              ? desiredHash
              : (existing?.last_published_hash ?? null),
            result.state,
            domainSync?.worktreeId ?? null,
            activeSnapshot?.id ?? null,
          ],
        )
      ).rows[0]!;
      const auditedDomain = domainSync?.domains.find(
        (domain) => view.viewId === `domain:${domain.name}`,
      );
      if (auditedDomain && domainSync) {
        await this.pool.query(
          `INSERT INTO project_knowledge.domain_sync_states
           (project_id,domain_id,worktree_id,projection_id,source_snapshot_id,state,note_path,
            current_commit,current_dirty_hash,indexed_commit,indexed_dirty_hash,last_synced_commit,
            last_synced_dirty_hash,database_revision,projection_revision,reasons,changed_paths,evidence_refs,unmapped_paths)
           SELECT $1,domain.id,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
           FROM project_knowledge.domains domain WHERE domain.project_id=$1 AND domain.name=$19
           ON CONFLICT(domain_id,worktree_id) DO UPDATE SET projection_id=EXCLUDED.projection_id,
             source_snapshot_id=EXCLUDED.source_snapshot_id,state=EXCLUDED.state,note_path=EXCLUDED.note_path,
             current_commit=EXCLUDED.current_commit,current_dirty_hash=EXCLUDED.current_dirty_hash,
             indexed_commit=EXCLUDED.indexed_commit,indexed_dirty_hash=EXCLUDED.indexed_dirty_hash,
             last_synced_commit=EXCLUDED.last_synced_commit,last_synced_dirty_hash=EXCLUDED.last_synced_dirty_hash,
             database_revision=EXCLUDED.database_revision,projection_revision=EXCLUDED.projection_revision,
             reasons=EXCLUDED.reasons,changed_paths=EXCLUDED.changed_paths,evidence_refs=EXCLUDED.evidence_refs,
             unmapped_paths=EXCLUDED.unmapped_paths,checked_at=now()`,
          [
            projectRow.project_id,
            domainSync.worktreeId,
            projection.id,
            activeSnapshot?.id ?? null,
            auditedDomain.state,
            view.relativePath,
            auditedDomain.currentCommit,
            auditedDomain.currentDirtyHash ?? null,
            domainSync.indexedCommit ?? null,
            domainSync.indexedDirtyHash ?? null,
            result.state === 'current'
              ? auditedDomain.currentCommit
              : (auditedDomain.lastSyncedCommit ?? null),
            result.state === 'current'
              ? (auditedDomain.currentDirtyHash ?? null)
              : (auditedDomain.lastSyncedDirtyHash ?? null),
            auditedDomain.databaseRevision,
            result.state === 'current'
              ? projectRow.db_revision
              : (auditedDomain.projectionRevision ?? null),
            auditedDomain.reasons,
            auditedDomain.changedPaths,
            auditedDomain.evidenceRefs,
            domainSync.unmappedChanges,
            auditedDomain.name,
          ],
        );
      }
      if (result.state === 'drifted') {
        drifted++;
        if (result.conflictCreated)
          await this.pool.query(
            `INSERT INTO project_knowledge.projection_conflicts
          (project_id,projection_id,expected_hash,observed_hash,preserved_path)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [
              projectRow.project_id,
              projection.id,
              desiredHash,
              result.observedHash,
              result.preservedPath,
            ],
          );
      } else {
        current++;
        await this.pool.query(
          `UPDATE project_knowledge.projection_conflicts SET resolved_at=now()
           WHERE projection_id=$1 AND resolved_at IS NULL`,
          [projection.id],
        );
      }
    }
    const retiredTaskProjections = (
      await this.pool.query<{
        id: string;
        relative_path: string;
        last_published_hash: string | null;
      }>(
        `SELECT id,relative_path,last_published_hash
         FROM project_knowledge.note_projections
         WHERE project_id=$1 AND (view_id='task-activity' OR view_id LIKE 'agent-task:%')`,
        [projectRow.project_id],
      )
    ).rows;
    for (const projection of retiredTaskProjections) {
      await removeProjection(
        project.vaultPath,
        projection.relative_path,
        projection.last_published_hash ?? undefined,
      );
      await this.pool.query(
        'DELETE FROM project_knowledge.projection_conflicts WHERE projection_id=$1',
        [projection.id],
      );
      await this.pool.query(
        'DELETE FROM project_knowledge.note_projections WHERE id=$1',
        [projection.id],
      );
    }
    await this.pool.query(
      `UPDATE project_knowledge.outbox_jobs SET state='done',last_error=NULL
      WHERE project_id=$1 AND job_type='publish_item' AND state IN ('pending','failed','processing')`,
      [projectRow.project_id],
    );
    return { current, drifted };
  }

  async processEmbeddings(limit = 50): Promise<number> {
    if (!this.embeddingQueue) return 0;
    const stats = await this.embeddingQueue.processBatch(limit);
    return stats.claimed + stats.retired + stats.reused + stats.completed;
  }
}
