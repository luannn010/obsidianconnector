import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type QueryResultRow } from 'pg';
import { canonicalHash } from './hash.js';
import { KnowledgeError } from './errors.js';
import {
  countSerializedTokens,
  packWithinTokenBudget,
  type TokenBudget,
} from './token-budget.js';
import type {
  ContextHit,
  ContextResults,
  ExpandProjectContextInput,
  KnowledgeChange,
  KnowledgeStore,
  KnowledgeWriteResult,
  ProjectSnapshot,
  ProjectSnapshotInput,
  ProjectSyncStatus,
  SearchProjectContextInput,
  SyncStatusInput,
  WriteProjectKnowledgeInput,
} from './types.js';

export interface PgQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  rows: Row[];
}
export interface PgClientLike {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<PgQueryResult<Row>>;
  release(): void;
}
export interface PgPoolLike {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<PgQueryResult<Row>>;
  connect(): Promise<PgClientLike>;
}
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}
export interface Reranker {
  rerank(query: string, hits: ContextHit[]): Promise<ContextHit[]>;
}

interface ProjectRow extends QueryResultRow {
  project_id: string;
  db_revision: number;
}
interface SnapshotRow extends QueryResultRow {
  project_id: string;
  db_revision: number;
  worktree_id: string;
  snapshot_id: string;
  head_commit: string;
  snapshot_head: string;
  state: string;
}
interface ChunkRow extends QueryResultRow {
  id: string;
  kind: string;
  title: string;
  content: string;
  content_hash: string;
  item_id: string | null;
  item_version: number | null;
  stable_key: string | null;
  metadata: Record<string, unknown>;
  head_commit: string | null;
  db_revision: number;
  documentation_freshness?: ContextHit['documentationFreshness'] | null;
}
interface ItemRow extends QueryResultRow {
  id: string;
  stable_key: string;
  kind: string;
  title: string;
  current_version: number;
  delivery_status: string | null;
  verification_status: string;
  domain: string | null;
  service: string | null;
  body_markdown: string;
  properties: Record<string, unknown>;
  canonical_hash: string;
}

const evidenceRequiredKinds = new Set([
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
  'work_item',
]);

export interface PgKnowledgeStoreOptions {
  embedder?: EmbeddingProvider;
  reranker?: Reranker;
  rerankerEnabled?: boolean;
}

function asKnowledgeError(error: unknown): KnowledgeError {
  if (error instanceof KnowledgeError) return error;
  const databaseError = error as { code?: unknown; message?: unknown };
  return new KnowledgeError(
    'DB_UNAVAILABLE',
    'Project knowledge database is unavailable',
    true,
    {
      ...(typeof databaseError.code === 'string'
        ? { databaseCode: databaseError.code }
        : {}),
      ...(typeof databaseError.message === 'string'
        ? { databaseMessage: databaseError.message.slice(0, 300) }
        : {}),
    },
  );
}

function hitFromChunk(row: ChunkRow, full = false): ContextHit {
  const metadata = row.metadata ?? {};
  const content = full ? row.content : row.content.slice(0, 900);
  return {
    ref: `chunk:${row.id}`,
    kind: row.kind,
    title: row.title,
    excerpt: content,
    citation: String(metadata.citation ?? metadata.path ?? row.title),
    contentHash: row.content_hash,
    ...(row.item_id ? { itemId: row.item_id } : {}),
    ...(row.item_version !== null && row.item_version !== undefined
      ? { itemVersion: Number(row.item_version) }
      : {}),
    ...(row.stable_key ? { stableKey: row.stable_key } : {}),
    estimatedTokens: countSerializedTokens(content),
    ...(typeof metadata.path === 'string' ? { path: metadata.path } : {}),
    ...(typeof metadata.symbol === 'string' ? { symbol: metadata.symbol } : {}),
    ...(typeof metadata.heading === 'string'
      ? { heading: metadata.heading }
      : {}),
    ...(row.documentation_freshness
      ? { documentationFreshness: row.documentation_freshness }
      : {}),
  };
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { offset?: unknown };
    if (!Number.isInteger(parsed.offset) || Number(parsed.offset) < 0)
      throw new Error('bad cursor');
    return Number(parsed.offset);
  } catch {
    throw new KnowledgeError(
      'CURSOR_EXPIRED',
      'Context cursor is invalid or expired',
      false,
    );
  }
}

export class PgKnowledgeStore implements KnowledgeStore {
  constructor(
    private readonly pool: PgPoolLike,
    private readonly options: PgKnowledgeStoreOptions = {},
  ) {}

  async getProjectSnapshot(
    input: ProjectSnapshotInput,
  ): Promise<ProjectSnapshot> {
    try {
      const result = await this.pool.query<SnapshotRow>(
        `
        SELECT p.project_id, p.db_revision, w.id AS worktree_id, s.id AS snapshot_id,
               w.head_commit, s.head_commit AS snapshot_head, s.state
        FROM project_knowledge.projects p
        JOIN project_knowledge.repositories r ON r.project_id = p.project_id
        JOIN project_knowledge.worktrees w ON w.repository_id = r.id AND w.project_id = p.project_id
        JOIN LATERAL (
          SELECT id, head_commit, state FROM project_knowledge.source_snapshots
          WHERE project_id = p.project_id AND worktree_id = w.id AND state = 'active'
          ORDER BY activated_at DESC NULLS LAST LIMIT 1
        ) s ON true
        WHERE p.project_key = $1 AND w.path = $2
      `,
        [input.projectKey, path.resolve(input.worktreePath)],
      );
      const row = result.rows[0];
      if (!row)
        throw new KnowledgeError(
          'INDEX_STALE',
          'No active index snapshot exists for this worktree',
          true,
        );
      const task = input.taskId
        ? (
            await this.pool.query<{
              id: string;
              agent: 'codex' | 'claude';
              external_task_id: string;
              task_name: string;
            }>(
              `INSERT INTO project_knowledge.agent_tasks
               (project_id,agent,external_task_id,task_name,worktree_id,start_snapshot_id,status,last_seen_at)
               VALUES($1,$2,$3,$4,$5,$6,'active',now())
               ON CONFLICT(project_id,agent,external_task_id) DO UPDATE SET
                 worktree_id=EXCLUDED.worktree_id,
                 start_snapshot_id=COALESCE(project_knowledge.agent_tasks.start_snapshot_id,EXCLUDED.start_snapshot_id),
                 task_name=CASE WHEN EXCLUDED.task_name<>'Untitled task' THEN EXCLUDED.task_name ELSE project_knowledge.agent_tasks.task_name END,
                 last_seen_at=now()
               RETURNING id,agent,external_task_id,task_name`,
              [
                row.project_id,
                input.agent ?? 'codex',
                input.taskId,
                input.taskName?.trim().slice(0, 120) || 'Untitled task',
                row.worktree_id,
                row.snapshot_id,
              ],
            )
          ).rows[0]
        : undefined;
      const items = await this.pool.query<ChunkRow>(
        `
        SELECT c.id, c.kind, c.title, c.content, c.content_hash, c.metadata,
               c.item_id, i.current_version AS item_version, i.stable_key,
               $3::text AS head_commit, $4::bigint AS db_revision,
               COALESCE(df.state,CASE WHEN c.item_id IS NOT NULL THEN 'unverified' END) AS documentation_freshness
        FROM project_knowledge.search_chunks c
        LEFT JOIN project_knowledge.knowledge_items i ON i.id=c.item_id AND i.project_id=c.project_id
        LEFT JOIN LATERAL (
          SELECT state FROM project_knowledge.documentation_freshness
          WHERE item_id=c.item_id AND snapshot_id=$2
            AND knowledge_version_id=(SELECT id FROM project_knowledge.knowledge_versions WHERE item_id=i.id AND version=i.current_version)
          ORDER BY checked_at DESC LIMIT 1
        ) df ON true
        WHERE c.project_id = $1 AND c.active AND (c.snapshot_id IS NULL OR c.snapshot_id = $2)
          AND c.kind = ANY($5::text[])
        ORDER BY CASE c.kind WHEN 'architecture' THEN 0 WHEN 'active_work' THEN 1 WHEN 'completed_work' THEN 2 ELSE 3 END,
                 c.title
        LIMIT 40
      `,
        [
          row.project_id,
          row.snapshot_id,
          row.snapshot_head,
          row.db_revision,
          [
            'architecture',
            'completed_work',
            'active_work',
            'blocker',
            'constraint',
          ],
        ],
      );
      const groups = new Map<string, ContextHit[]>();
      const selected: ChunkRow[] = [];
      const base = {
        projectKey: input.projectKey,
        snapshotId: row.snapshot_id,
        worktreeId: row.worktree_id,
        gitRevision: row.snapshot_head,
        dbRevision: Number(row.db_revision),
        freshness:
          row.head_commit === row.snapshot_head
            ? ('current' as const)
            : ('stale' as const),
        ...(task
          ? {
              task: {
                ref: `task:${task.agent}:${task.external_task_id}`,
                agent: task.agent,
                taskId: task.external_task_id,
                taskName: task.task_name,
              },
            }
          : {}),
      };
      for (const item of items.rows) {
        const group = groups.get(item.kind) ?? [];
        group.push(hitFromChunk(item));
        groups.set(item.kind, group);
        selected.push(item);
        const preview = {
          ...base,
          architecture: groups.get('architecture') ?? [],
          completed: groups.get('completed_work') ?? [],
          active: groups.get('active_work') ?? [],
          blockers: groups.get('blocker') ?? [],
          constraints: groups.get('constraint') ?? [],
          refs: selected.map((entry) => `chunk:${entry.id}`),
          budget: {
            limit: input.maxTokens,
            used: 0,
            truncated: selected.length < items.rows.length,
            omitted: items.rows.length - selected.length,
          },
        };
        if (countSerializedTokens(preview) > input.maxTokens) {
          group.pop();
          selected.pop();
          break;
        }
      }
      const snapshot: ProjectSnapshot = {
        ...base,
        architecture: groups.get('architecture') ?? [],
        completed: groups.get('completed_work') ?? [],
        active: groups.get('active_work') ?? [],
        blockers: groups.get('blocker') ?? [],
        constraints: groups.get('constraint') ?? [],
        refs: selected.map((item) => `chunk:${item.id}`),
        budget: {
          limit: input.maxTokens,
          used: 0,
          truncated: selected.length < items.rows.length,
          omitted: items.rows.length - selected.length,
          ...(selected.length < items.rows.length
            ? {
                continuation: Buffer.from(
                  JSON.stringify({ offset: selected.length }),
                  'utf8',
                ).toString('base64url'),
              }
            : {}),
        },
      };
      for (let attempt = 0; attempt < 4; attempt++) {
        const used = countSerializedTokens(snapshot);
        if (snapshot.budget.used === used) break;
        snapshot.budget.used = used;
      }
      return snapshot;
    } catch (error) {
      throw asKnowledgeError(error);
    }
  }

  async searchProjectContext(
    input: SearchProjectContextInput,
  ): Promise<ContextResults & { budget: TokenBudget }> {
    const offset = decodeCursor(input.cursor);
    try {
      const project = await this.pool.query<ProjectRow>(
        'SELECT project_id, db_revision FROM project_knowledge.projects WHERE project_key = $1',
        [input.projectKey],
      );
      const projectRow = project.rows[0];
      if (!projectRow)
        throw new KnowledgeError(
          'INDEX_STALE',
          'Project has not been indexed',
          true,
        );
      const exactLike =
        input.mode === 'exact' ||
        (input.mode === 'auto' &&
          /[/\\:.]|\b(GET|POST|PUT|PATCH|DELETE)\b/iu.test(input.query));
      let rows: ChunkRow[] = [];
      if (exactLike || input.mode === 'structured') {
        const result = await this.pool.query<ChunkRow>(
          `
          SELECT c.id, c.kind, c.title, c.content, c.content_hash, c.metadata,
                 c.item_id, i.current_version AS item_version, i.stable_key,
                 s.head_commit, $4::bigint AS db_revision,
                 COALESCE(df.state,CASE WHEN c.item_id IS NOT NULL THEN 'unverified' END) AS documentation_freshness
          FROM project_knowledge.search_chunks c
          LEFT JOIN project_knowledge.knowledge_items i ON i.id=c.item_id AND i.project_id=c.project_id
          LEFT JOIN project_knowledge.source_snapshots s ON s.id = c.snapshot_id
          LEFT JOIN LATERAL (
            SELECT state FROM project_knowledge.documentation_freshness
            WHERE item_id=c.item_id
              AND ($2::uuid IS NULL OR snapshot_id=$2)
              AND ($5::uuid IS NULL OR worktree_id=$5)
              AND knowledge_version_id=(SELECT id FROM project_knowledge.knowledge_versions WHERE item_id=i.id AND version=i.current_version)
            ORDER BY checked_at DESC LIMIT 1
          ) df ON true
          WHERE c.project_id = $1 AND c.active AND ($2::uuid IS NULL OR c.snapshot_id IS NULL OR c.snapshot_id = $2)
            AND ($3 = c.parent_ref OR lower(c.title) = lower($3)
              OR lower(c.metadata->>'path') = lower($3) OR lower(c.metadata->>'symbol') = lower($3)
              OR lower(c.metadata->>'endpoint') = lower($3) OR lower(c.metadata->>'schema_table') = lower($3))
          LIMIT 30
        `,
          [
            projectRow.project_id,
            input.snapshotId ?? null,
            input.query,
            projectRow.db_revision,
            input.worktreeId ?? null,
          ],
        );
        rows = result.rows;
      }
      const warnings: string[] = [];
      let usedHybridRetrieval = false;
      if (
        rows.length === 0 &&
        input.mode !== 'exact' &&
        input.mode !== 'structured'
      ) {
        usedHybridRetrieval = true;
        let embedding: number[] | undefined;
        if (this.options.embedder) {
          try {
            embedding = await this.options.embedder.embed(input.query);
          } catch {
            warnings.push(
              'Semantic retrieval unavailable; BM25 results returned',
            );
          }
        }
        const kindFilter = input.filters?.kinds ?? null;
        const domainFilter = input.filters?.domains ?? null;
        const serviceFilter = input.filters?.services ?? null;
        const values: unknown[] = [
          projectRow.project_id,
          input.snapshotId ?? null,
          input.query,
          30,
          embedding ? `[${embedding.join(',')}]` : null,
          kindFilter,
          domainFilter,
          serviceFilter,
          projectRow.db_revision,
        ];
        const sql = embedding
          ? `
          WITH bm25 AS MATERIALIZED (
            SELECT id, row_number() OVER (ORDER BY paradedb.score(id) DESC) AS rank
            FROM project_knowledge.search_chunks WHERE content @@@ $3 AND project_id = $1 AND active
              AND ($2::uuid IS NULL OR snapshot_id IS NULL OR snapshot_id=$2)
              AND ($6::text[] IS NULL OR kind=ANY($6)) AND ($7::text[] IS NULL OR domain=ANY($7))
              AND ($8::text[] IS NULL OR service=ANY($8)) LIMIT $4
          ), vector AS (
            SELECT id, row_number() OVER (ORDER BY embedding <=> $5::vector) AS rank
            FROM project_knowledge.search_chunks
            WHERE project_id = $1 AND active AND embedding IS NOT NULL
              AND ($2::uuid IS NULL OR snapshot_id IS NULL OR snapshot_id=$2)
              AND ($6::text[] IS NULL OR kind=ANY($6)) AND ($7::text[] IS NULL OR domain=ANY($7))
              AND ($8::text[] IS NULL OR service=ANY($8))
            ORDER BY embedding <=> $5::vector LIMIT $4
          )
          SELECT c.id, c.kind, c.title, c.content, c.content_hash, c.metadata,
                 c.item_id, i.current_version AS item_version, i.stable_key,
                 s.head_commit, $9::bigint AS db_revision,
                 COALESCE(df.state,CASE WHEN c.item_id IS NOT NULL THEN 'unverified' END) AS documentation_freshness,
                 COALESCE(1.0/(60+b.rank),0)+COALESCE(1.0/(60+v.rank),0) AS score
          FROM project_knowledge.search_chunks c LEFT JOIN bm25 b ON b.id=c.id LEFT JOIN vector v ON v.id=c.id
          LEFT JOIN project_knowledge.knowledge_items i ON i.id=c.item_id AND i.project_id=c.project_id
          LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
          LEFT JOIN LATERAL (
            SELECT state FROM project_knowledge.documentation_freshness
            WHERE item_id=c.item_id AND ($2::uuid IS NULL OR snapshot_id=$2)
              AND knowledge_version_id=(SELECT id FROM project_knowledge.knowledge_versions WHERE item_id=i.id AND version=i.current_version)
            ORDER BY checked_at DESC LIMIT 1
          ) df ON true
          WHERE (b.id IS NOT NULL OR v.id IS NOT NULL) AND c.project_id=$1 AND c.active
            AND ($2::uuid IS NULL OR c.snapshot_id IS NULL OR c.snapshot_id=$2)
            AND ($6::text[] IS NULL OR c.kind=ANY($6)) AND ($7::text[] IS NULL OR c.domain=ANY($7))
            AND ($8::text[] IS NULL OR c.service=ANY($8))
          ORDER BY score DESC LIMIT $4 OFFSET ${offset}
        `
          : `
          WITH bm25 AS MATERIALIZED (
            SELECT id,paradedb.score(id) AS score FROM project_knowledge.search_chunks
            WHERE content @@@ $3 AND project_id=$1 AND active
              AND ($2::uuid IS NULL OR snapshot_id IS NULL OR snapshot_id=$2)
              AND ($6::text[] IS NULL OR kind=ANY($6)) AND ($7::text[] IS NULL OR domain=ANY($7))
              AND ($8::text[] IS NULL OR service=ANY($8))
            ORDER BY score DESC LIMIT $4 OFFSET ${offset}
          )
          SELECT c.id, c.kind, c.title, c.content, c.content_hash, c.metadata,
                 c.item_id, i.current_version AS item_version, i.stable_key,
                 s.head_commit, $9::bigint AS db_revision,
                 COALESCE(df.state,CASE WHEN c.item_id IS NOT NULL THEN 'unverified' END) AS documentation_freshness
          FROM bm25 b JOIN project_knowledge.search_chunks c ON c.id=b.id
          LEFT JOIN project_knowledge.knowledge_items i ON i.id=c.item_id AND i.project_id=c.project_id
          LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
          LEFT JOIN LATERAL (
            SELECT state FROM project_knowledge.documentation_freshness
            WHERE item_id=c.item_id AND ($2::uuid IS NULL OR snapshot_id=$2)
              AND knowledge_version_id=(SELECT id FROM project_knowledge.knowledge_versions WHERE item_id=i.id AND version=i.current_version)
            ORDER BY checked_at DESC LIMIT 1
          ) df ON true
          WHERE c.project_id=$1 AND $5::text IS NULL
            AND ($2::uuid IS NULL OR c.snapshot_id IS NULL OR c.snapshot_id=$2)
            AND ($6::text[] IS NULL OR c.kind=ANY($6)) AND ($7::text[] IS NULL OR c.domain=ANY($7))
            AND ($8::text[] IS NULL OR c.service=ANY($8))
          ORDER BY b.score DESC LIMIT $4
        `;
        rows = (await this.pool.query<ChunkRow>(sql, values)).rows;
      }
      let hits = [
        ...new Map(rows.map((row) => [row.id, hitFromChunk(row)])).values(),
      ];
      if (
        usedHybridRetrieval &&
        this.options.rerankerEnabled &&
        this.options.reranker &&
        hits.length > 1
      ) {
        hits = await this.options.reranker.rerank(
          input.query,
          hits.slice(0, 20),
        );
      }
      const packed = packWithinTokenBudget(
        hits.slice(0, input.limit),
        input.maxTokens,
        {
          freshness: rows.some(
            (row) => row.head_commit && input.snapshotId === undefined,
          )
            ? 'stale'
            : 'current',
          gitRevision: rows[0]?.head_commit ?? '',
          dbRevision: Number(projectRow.db_revision),
          warnings,
        },
      );
      return {
        ...(packed.metadata as Omit<ContextResults, 'results'>),
        results: packed.results,
        budget: packed.budget,
      };
    } catch (error) {
      throw asKnowledgeError(error);
    }
  }

  async expandProjectContext(
    input: ExpandProjectContextInput,
  ): Promise<ContextResults & { budget: TokenBudget }> {
    try {
      const chunkIds = input.refs
        .filter((ref) => ref.startsWith('chunk:'))
        .map((ref) => ref.slice(6));
      const result = await this.pool.query<ChunkRow>(
        `
        SELECT c.id, c.kind, c.title, c.content, c.content_hash, c.metadata,
               c.item_id, i.current_version AS item_version, i.stable_key,
               s.head_commit, p.db_revision,
               COALESCE(df.state,CASE WHEN c.item_id IS NOT NULL THEN 'unverified' END) AS documentation_freshness
        FROM project_knowledge.search_chunks c JOIN project_knowledge.projects p ON p.project_id=c.project_id
        LEFT JOIN project_knowledge.knowledge_items i ON i.id=c.item_id AND i.project_id=c.project_id
        LEFT JOIN project_knowledge.source_snapshots s ON s.id=c.snapshot_id
        LEFT JOIN LATERAL (
          SELECT state FROM project_knowledge.documentation_freshness
          WHERE item_id=c.item_id AND ($3::uuid IS NULL OR snapshot_id=$3)
            AND knowledge_version_id=(SELECT id FROM project_knowledge.knowledge_versions WHERE item_id=i.id AND version=i.current_version)
          ORDER BY checked_at DESC LIMIT 1
        ) df ON true
        WHERE p.project_key=$1 AND c.active AND c.id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR c.snapshot_id IS NULL OR c.snapshot_id=$3)
      `,
        [input.projectKey, chunkIds, input.snapshotId ?? null],
      );
      const hits = result.rows.map((row) => hitFromChunk(row, true));
      const packed = packWithinTokenBudget(hits, input.maxTokens, {
        freshness: 'current' as const,
        gitRevision: result.rows[0]?.head_commit ?? '',
        dbRevision: Number(result.rows[0]?.db_revision ?? 0),
      });
      return {
        ...packed.metadata,
        results: packed.results,
        budget: packed.budget,
      };
    } catch (error) {
      throw asKnowledgeError(error);
    }
  }

  async writeProjectKnowledge(
    input: WriteProjectKnowledgeInput,
  ): Promise<KnowledgeWriteResult> {
    const client = await this.pool.connect().catch((error: unknown) => {
      throw asKnowledgeError(error);
    });
    try {
      await client.query('BEGIN');
      const project = await client.query<ProjectRow>(
        `
        SELECT project_id, db_revision FROM project_knowledge.projects WHERE project_key=$1 FOR UPDATE
      `,
        [input.projectKey],
      );
      const projectRow = project.rows[0];
      if (!projectRow)
        throw new KnowledgeError(
          'INDEX_STALE',
          'Project is not registered',
          false,
        );
      if (
        input.expectedProjectRevision !== undefined &&
        Number(projectRow.db_revision) !== input.expectedProjectRevision
      ) {
        throw new KnowledgeError(
          'VERSION_CONFLICT',
          'Project knowledge revision changed',
          false,
          {
            expected: input.expectedProjectRevision,
            actual: Number(projectRow.db_revision),
          },
        );
      }
      const nextRevision = Number(projectRow.db_revision) + 1;
      const requestsVerifiedCompletion = input.changes.some(
        (change) =>
          change.item.deliveryStatus === 'completed' &&
          change.item.verificationStatus !== undefined &&
          change.item.verificationStatus !== 'unverified',
      );
      if (requestsVerifiedCompletion && input.taskId) {
        const stale = await client.query<{ ref: string; state: string }>(
          `
          SELECT DISTINCT 'knowledge:'||i.id||':v'||i.current_version AS ref, df.state
          FROM project_knowledge.agent_tasks t
          JOIN project_knowledge.task_file_rollups f ON f.task_id=t.id AND f.changed_by_task
          JOIN project_knowledge.source_evidence e ON e.project_id=t.project_id
            AND e.source_path=f.repo_relative_path AND e.required
          JOIN project_knowledge.knowledge_items i ON i.id=e.item_id AND i.current_version=(
            SELECT version FROM project_knowledge.knowledge_versions WHERE id=e.knowledge_version_id
          )
          JOIN project_knowledge.source_snapshots active_snapshot
            ON active_snapshot.worktree_id=t.worktree_id AND active_snapshot.state='active'
          LEFT JOIN project_knowledge.documentation_freshness df
            ON df.item_id=e.item_id AND df.knowledge_version_id=e.knowledge_version_id
            AND df.worktree_id=t.worktree_id AND df.snapshot_id=active_snapshot.id
          WHERE t.project_id=$1 AND t.external_task_id=$2
            AND COALESCE(df.state,'unverified') <> 'current'
          LIMIT 20`,
          [projectRow.project_id, input.taskId],
        );
        if (stale.rows.length) {
          throw new KnowledgeError(
            'DOCS_STALE',
            'Required documentation is stale for sources changed by this task',
            false,
            { refs: stale.rows.map((row) => row.ref) },
          );
        }
      }
      const changes = [] as KnowledgeWriteResult['changes'];
      for (const change of input.changes) {
        changes.push(
          await this.applyChange(client, projectRow.project_id, input, change),
        );
      }
      await client.query(
        'UPDATE project_knowledge.projects SET db_revision=$2, updated_at=now() WHERE project_id=$1',
        [projectRow.project_id, nextRevision],
      );
      await client.query('COMMIT');
      return {
        projectKey: input.projectKey,
        dbRevision: nextRevision,
        changes,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw asKnowledgeError(error);
    } finally {
      client.release();
    }
  }

  private async applyChange(
    client: PgClientLike,
    projectId: string,
    input: WriteProjectKnowledgeInput,
    change: KnowledgeChange,
  ): Promise<KnowledgeWriteResult['changes'][number]> {
    let existing: ItemRow | undefined;
    if (change.item.id) {
      existing = (
        await client.query<ItemRow>(
          `
        SELECT i.*, v.body_markdown, v.properties, v.canonical_hash
        FROM project_knowledge.knowledge_items i JOIN project_knowledge.knowledge_versions v
          ON v.item_id=i.id AND v.version=i.current_version
        WHERE i.project_id=$1 AND i.id=$2 FOR UPDATE OF i
      `,
          [projectId, change.item.id],
        )
      ).rows[0];
    }
    if (change.operation !== 'create' && !existing) {
      throw new KnowledgeError(
        'VERSION_CONFLICT',
        'Knowledge item does not exist at the requested version',
        false,
      );
    }
    if (
      existing &&
      change.expectedVersion !== undefined &&
      existing.current_version !== change.expectedVersion
    ) {
      throw new KnowledgeError(
        'VERSION_CONFLICT',
        'Knowledge item version changed',
        false,
        {
          itemId: existing.id,
          expected: change.expectedVersion,
          actual: existing.current_version,
        },
      );
    }
    const itemId = existing?.id ?? change.item.id ?? randomUUID();
    const version = (existing?.current_version ?? 0) + 1;
    const title = change.item.title ?? existing?.title;
    if (!title)
      throw new KnowledgeError(
        'VERSION_CONFLICT',
        'Knowledge title is required',
        false,
      );
    const priorBody = existing?.body_markdown ?? '';
    const bodyMarkdown =
      change.operation === 'append'
        ? [priorBody.trimEnd(), change.item.bodyMarkdown ?? '']
            .filter(Boolean)
            .join('\n\n')
        : (change.item.bodyMarkdown ?? priorBody);
    const properties = {
      ...(existing?.properties ?? {}),
      ...(change.item.properties ?? {}),
    };
    const record = {
      kind: change.item.kind ?? existing?.kind,
      title,
      bodyMarkdown,
      properties,
      deliveryStatus:
        change.item.deliveryStatus ?? existing?.delivery_status ?? null,
      verificationStatus:
        change.item.verificationStatus ??
        existing?.verification_status ??
        'unverified',
      domain: change.item.domain ?? existing?.domain ?? null,
      service: change.item.service ?? existing?.service ?? null,
    };
    if (
      record.verificationStatus === 'source_verified' &&
      evidenceRequiredKinds.has(record.kind) &&
      !change.evidence?.length
    )
      throw new KnowledgeError(
        'DOCS_STALE',
        'Source evidence is required before this documentation can be source verified',
        false,
        { kind: record.kind, itemId },
      );
    const hash = canonicalHash(record);
    if (!existing) {
      const stableKey =
        change.item.stableKey ??
        `${change.item.kind}:${title
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, '-')
          .replace(/^-|-$/gu, '')}:${itemId.slice(0, 8)}`;
      await client.query(
        `INSERT INTO project_knowledge.knowledge_items
        (id,project_id,kind,stable_key,title,current_version,delivery_status,verification_status,domain,service)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          itemId,
          projectId,
          change.item.kind,
          stableKey,
          title,
          version,
          record.deliveryStatus,
          record.verificationStatus,
          record.domain,
          record.service,
        ],
      );
    } else {
      await client.query(
        `UPDATE project_knowledge.knowledge_items SET title=$3,current_version=$4,
        delivery_status=$5,verification_status=$6,domain=$7,service=$8,updated_at=now()
        WHERE project_id=$1 AND id=$2`,
        [
          projectId,
          itemId,
          title,
          version,
          record.deliveryStatus,
          record.verificationStatus,
          record.domain,
          record.service,
        ],
      );
    }
    if (record.kind === 'work_item') {
      const workItem = (
        await client.query<{ id: string }>(
          `INSERT INTO project_knowledge.work_items
           (project_id,item_id,status,verification_status)
           VALUES($1,$2,$3,$4)
           ON CONFLICT(item_id) DO UPDATE SET status=EXCLUDED.status,
             verification_status=EXCLUDED.verification_status
           RETURNING id`,
          [
            projectId,
            itemId,
            record.deliveryStatus ?? 'needs_review',
            record.verificationStatus,
          ],
        )
      ).rows[0];
      if (
        workItem &&
        (!existing || existing.delivery_status !== record.deliveryStatus)
      )
        await client.query(
          `INSERT INTO project_knowledge.status_events
           (project_id,work_item_id,from_status,to_status,actor,task_id)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [
            projectId,
            workItem.id,
            existing?.delivery_status ?? null,
            record.deliveryStatus ?? 'needs_review',
            input.actor,
            input.taskId ?? null,
          ],
        );
      if (workItem && input.taskId)
        await client.query(
          `INSERT INTO project_knowledge.worktree_links(project_id,worktree_id,work_item_id)
           SELECT $1,t.worktree_id,$2 FROM project_knowledge.agent_tasks t
           WHERE t.project_id=$1 AND t.external_task_id=$3 AND t.worktree_id IS NOT NULL
           ON CONFLICT(worktree_id,work_item_id) DO NOTHING`,
          [projectId, workItem.id, input.taskId],
        );
    }
    const insertedVersion = await client.query<{ id: string }>(
      `INSERT INTO project_knowledge.knowledge_versions
      (project_id,item_id,version,body_markdown,properties,canonical_hash,actor,task_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id`,
      [
        projectId,
        itemId,
        version,
        bodyMarkdown,
        properties,
        hash,
        input.actor,
        input.taskId ?? null,
      ],
    );
    const knowledgeVersionId = insertedVersion.rows[0]?.id;
    if (!knowledgeVersionId)
      throw new KnowledgeError(
        'DB_UNAVAILABLE',
        'Knowledge version could not be created',
        true,
      );
    for (const evidence of change.evidence ?? []) {
      const chunkId = evidence.ref.startsWith('chunk:')
        ? evidence.ref.slice('chunk:'.length)
        : '';
      if (!chunkId)
        throw new KnowledgeError(
          'INDEX_STALE',
          'Evidence must reference a snapshot search chunk',
          false,
          { ref: evidence.ref },
        );
      const locatorType = evidence.locatorType ?? 'path';
      const source = (
        await client.query<{
          id: string;
          worktree_id: string;
          source_path: string;
          source_ref: string | null;
          source_hash: string;
        }>(
          `SELECT evidence.id,s.worktree_id,evidence.metadata->>'path' AS source_path,
             CASE $4
               WHEN 'symbol' THEN evidence.metadata->>'symbol'
               WHEN 'endpoint' THEN evidence.metadata->>'endpoint'
               WHEN 'table' THEN evidence.metadata->>'schema_table'
               ELSE NULL
             END AS source_ref,
             CASE WHEN $4 IN ('path','migration','test') THEN source_file.source_hash
               ELSE evidence.content_hash END AS source_hash
           FROM project_knowledge.search_chunks evidence
           JOIN project_knowledge.source_snapshots s ON s.id=evidence.snapshot_id
           JOIN project_knowledge.code_files source_file
             ON source_file.snapshot_id=evidence.snapshot_id
             AND source_file.repo_relative_path=evidence.metadata->>'path'
           WHERE evidence.project_id=$1 AND evidence.snapshot_id=$2 AND evidence.id=$3
             AND evidence.active AND evidence.metadata ? 'path'`,
          [projectId, evidence.snapshotId, chunkId, locatorType],
        )
      ).rows[0];
      if (!source)
        throw new KnowledgeError(
          'INDEX_STALE',
          'Evidence reference is missing from the bound snapshot',
          false,
          { ref: evidence.ref, snapshotId: evidence.snapshotId },
        );
      await client.query(
        `INSERT INTO project_knowledge.source_evidence
         (project_id,item_id,knowledge_version_id,snapshot_id,evidence_type,locator_type,
          source_path,source_ref,source_hash,required,verification_scope,metadata)
         VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11)`,
        [
          projectId,
          itemId,
          knowledgeVersionId,
          evidence.snapshotId,
          locatorType,
          source.source_path,
          source.source_ref,
          source.source_hash,
          evidence.required ?? evidence.verificationScope === 'required',
          evidence.verificationScope ??
            (evidence.required ? 'required' : 'warning'),
          { ref: evidence.ref, capture: 'agent_write' },
        ],
      );
      await client.query(
        `INSERT INTO project_knowledge.documentation_freshness
         (project_id,item_id,knowledge_version_id,worktree_id,snapshot_id,state,reason)
         VALUES($1,$2,$3,$4,$5,'current','Evidence verified against bound snapshot')
         ON CONFLICT(item_id,knowledge_version_id,worktree_id,snapshot_id) DO UPDATE SET
           state='current',reason=EXCLUDED.reason,checked_at=now()`,
        [
          projectId,
          itemId,
          knowledgeVersionId,
          source.worktree_id,
          evidence.snapshotId,
        ],
      );
    }
    await client.query(
      'UPDATE project_knowledge.search_chunks SET active=false WHERE project_id=$1 AND item_id=$2 AND active',
      [projectId, itemId],
    );
    const chunkId = randomUUID();
    await client.query(
      `INSERT INTO project_knowledge.search_chunks
      (id,project_id,item_id,kind,domain,service,title,content,content_hash,token_count,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        chunkId,
        projectId,
        itemId,
        change.item.kind,
        record.domain,
        record.service,
        title,
        `${title}\n\n${bodyMarkdown}`,
        hash,
        countSerializedTokens(`${title}\n\n${bodyMarkdown}`),
        { citation: `knowledge:${itemId}:v${version}`, itemVersion: version },
      ],
    );
    await client.query(
      `INSERT INTO project_knowledge.outbox_jobs(project_id,job_type,payload)
      VALUES($1,'embed_chunk',$2),($1,'publish_item',$3)`,
      [projectId, { chunkId }, { itemId, version }],
    );
    if (change.operation === 'supersede' && change.supersedesId) {
      await client.query(
        'UPDATE project_knowledge.knowledge_items SET superseded_by=$3,updated_at=now() WHERE project_id=$1 AND id=$2',
        [projectId, change.supersedesId, itemId],
      );
    }
    return {
      itemId,
      version,
      canonicalHash: hash,
      lexicalState: 'current',
      embeddingState: 'pending',
      projectionState: 'pending',
    };
  }

  async getProjectSyncStatus(
    input: SyncStatusInput,
  ): Promise<ProjectSyncStatus> {
    try {
      const project = await this.pool.query<ProjectRow>(
        'SELECT project_id, db_revision FROM project_knowledge.projects WHERE project_key=$1',
        [input.projectKey],
      );
      const row = project.rows[0];
      if (!row)
        throw new KnowledgeError(
          'INDEX_STALE',
          'Project is not registered',
          false,
        );
      const [snapshots, projections, queues, conflicts, freshness, tasks] =
        await Promise.all([
          this.pool.query(
            `SELECT w.id AS worktree_id,w.path,w.branch,w.head_commit,w.dirty_hash,w.registered,
             s.id AS snapshot_id,s.head_commit AS snapshot_head,s.dirty_hash AS snapshot_dirty_hash,
             CASE WHEN s.id IS NOT NULL AND s.head_commit=w.head_commit
               AND s.dirty_hash IS NOT DISTINCT FROM w.dirty_hash THEN 'current' ELSE 'stale' END AS freshness
           FROM project_knowledge.worktrees w
           LEFT JOIN LATERAL (
             SELECT id,head_commit,dirty_hash FROM project_knowledge.source_snapshots
             WHERE worktree_id=w.id AND state='active' ORDER BY activated_at DESC NULLS LAST LIMIT 1
           ) s ON true
           WHERE w.project_id=$1 AND ($2::uuid[] IS NULL OR w.id=ANY($2))
           ORDER BY w.last_seen_at DESC LIMIT 20`,
            [row.project_id, input.worktreeIds ?? null],
          ),
          this.pool.query(
            "SELECT view_id,relative_path,db_revision,state,updated_at,error_message FROM project_knowledge.note_projections WHERE project_id=$1 AND ($2::boolean=false OR state<>'current') ORDER BY relative_path",
            [row.project_id, input.changedOnly],
          ),
          this.pool.query<{ state: string; count: number }>(
            "SELECT state,count(*)::int AS count FROM project_knowledge.outbox_jobs WHERE project_id=$1 AND state IN ('pending','failed') GROUP BY state",
            [row.project_id],
          ),
          this.pool.query(
            'SELECT id,projection_id,preserved_path,created_at FROM project_knowledge.projection_conflicts WHERE project_id=$1 AND resolved_at IS NULL',
            [row.project_id],
          ),
          this.pool.query<{ state: string; count: number }>(
            `SELECT freshness.state,count(DISTINCT freshness.item_id)::int AS count
           FROM project_knowledge.documentation_freshness freshness
           JOIN project_knowledge.source_snapshots snapshot
             ON snapshot.id=freshness.snapshot_id AND snapshot.state='active'
           WHERE freshness.project_id=$1
             AND ($2::uuid[] IS NULL OR freshness.worktree_id=ANY($2))
             AND ($3::text[] IS NULL OR freshness.state=ANY($3))
           GROUP BY freshness.state`,
            [
              row.project_id,
              input.worktreeIds ?? null,
              input.filters?.documentation ?? null,
            ],
          ),
          this.pool.query(
            `SELECT t.agent,t.external_task_id AS task_id,t.task_name,t.status,t.worktree_id,
             w.branch,w.head_commit,t.started_at,t.last_seen_at
           FROM project_knowledge.agent_tasks t
           LEFT JOIN project_knowledge.worktrees w ON w.id=t.worktree_id
           WHERE t.project_id=$1
             AND ($2::uuid[] IS NULL OR t.worktree_id=ANY($2))
             AND ($3::text[] IS NULL OR t.external_task_id=ANY($3))
           ORDER BY t.last_seen_at DESC LIMIT 50`,
            [
              row.project_id,
              input.worktreeIds ?? null,
              input.filters?.tasks ?? null,
            ],
          ),
        ]);
      const counts = new Map(
        queues.rows.map((entry) => [entry.state, Number(entry.count)]),
      );
      return {
        projectKey: input.projectKey,
        dbRevision: Number(row.db_revision),
        sourceFreshness: snapshots.rows.some(
          (snapshot) => snapshot.freshness !== 'current',
        )
          ? 'stale'
          : 'current',
        snapshots: snapshots.rows,
        projections: projections.rows,
        queues: {
          pending: counts.get('pending') ?? 0,
          failed: counts.get('failed') ?? 0,
        },
        conflicts: conflicts.rows,
        documentationFreshness: Object.fromEntries(
          freshness.rows.map((entry) => [entry.state, Number(entry.count)]),
        ),
        tasks: tasks.rows,
      };
    } catch (error) {
      throw asKnowledgeError(error);
    }
  }
}

export function createPgKnowledgeStore(
  databaseUrl: string,
  poolMax = 4,
  statementTimeoutMs = 5000,
  options: PgKnowledgeStoreOptions = {},
): { store: PgKnowledgeStore; pool: Pool } {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: poolMax,
    statement_timeout: statementTimeoutMs,
    application_name: 'obsidian-local-knowledge',
  });
  return {
    store: new PgKnowledgeStore(pool as unknown as PgPoolLike, options),
    pool,
  };
}

export async function applyKnowledgeMigrations(
  pool: PgPoolLike,
  migrations: Array<{ id: string; sql: string }>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext('obsidian-local-project-knowledge-migrations'))",
    );
    const ledger = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('project_knowledge.schema_migrations') IS NOT NULL AS exists",
    );
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      if (ledger.rows[0]?.exists) {
        const applied = await client.query<{ checksum: string }>(
          'SELECT checksum FROM project_knowledge.schema_migrations WHERE id=$1',
          [migration.id],
        );
        if (applied.rows[0]) {
          if (applied.rows[0].checksum !== checksum) {
            throw new Error(
              `Migration ${migration.id} checksum does not match the applied migration`,
            );
          }
          continue;
        }
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO project_knowledge.schema_migrations(id,checksum) VALUES($1,$2)',
          [migration.id, checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client
      .query(
        "SELECT pg_advisory_unlock(hashtext('obsidian-local-project-knowledge-migrations'))",
      )
      .catch(() => undefined);
    client.release();
  }
}
