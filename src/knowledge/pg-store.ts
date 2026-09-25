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
  Freshness,
  ExpandProjectContextInput,
  KnowledgeChange,
  KnowledgeStore,
  KnowledgeWriteResult,
  ProjectSnapshot,
  ProjectSnapshotInput,
  ProjectSyncStatus,
  SyncStatusSummary,
  SyncSuggestedAction,
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
  embedMany?(texts: string[]): Promise<number[][]>;
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
  parser_revision: string | null;
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
  const message = typeof databaseError.message === 'string' ? databaseError.message : '';
  if (
    (error as { name?: unknown })?.name === 'TypeError' &&
    message.includes('deliveryStatus')
  ) {
    return new KnowledgeError(
      'VERSION_CONFLICT',
      'Knowledge write payload is malformed: missing or invalid item content',
      false,
      { reason: message.slice(0, 250) },
    );
  }
  return new KnowledgeError(
    'DB_UNAVAILABLE',
    'Project knowledge database is unavailable',
    true,
    {
      ...(typeof databaseError.code === 'string'
        ? { databaseCode: databaseError.code }
        : {}),
      ...(message ? { databaseMessage: message.slice(0, 300) } : {}),
    },
  );
}

interface DomainSyncRow extends QueryResultRow {
  worktree_id: string;
  worktree_path: string;
  branch: string;
  current_commit: string;
  current_dirty_hash: string | null;
  indexed_commit: string | null;
  indexed_dirty_hash: string | null;
  snapshot_id: string | null;
  domain: string;
  note_path: string;
  state: 'current' | 'stale' | 'possibly_stale' | 'unverified' | 'missing';
  last_synced_commit: string | null;
  last_synced_dirty_hash: string | null;
  database_revision: number;
  projection_revision: number | null;
  reasons: string[];
  changed_paths: string[];
  evidence_refs: string[];
  unmapped_paths: string[];
}
interface SyncEvidenceLookupRow extends QueryResultRow {
  source_path: string;
  item_id: string;
  stable_key: string;
  title: string;
}

interface SyncStatusCacheEntry {
  expiresAt: number;
  cacheKey: string;
  fingerprint: string;
  summary: SyncStatusSummary;
  topIssues: string[];
  topSuggestedActions: SyncSuggestedAction[];
}

const syncStatusCache = new Map<string, SyncStatusCacheEntry>();
const SYNC_STATUS_CACHE_TTL_MS = 5 * 60_000;
const COMPACT_STATUS_LIMITS = {
  snapshots: 3,
  projections: 10,
  conflicts: 10,
  tasks: 10,
  snapshotPaths: 8,
  domains: 5,
  reasons: 3,
  domainPaths: 8,
  domainEvidenceRefs: 8,
  unmappedChanges: 8,
  actionPaths: 12,
  actionItems: 8,
  evidenceRefs: 8,
} as const;

function tokenEstimate(values: {
  pathCount: number;
  itemCount: number;
}): number {
  const base = 24;
  return base + values.pathCount * 90 + values.itemCount * 80;
}

function compactSuggestedAction(
  action: SyncSuggestedAction,
): SyncSuggestedAction {
  const changedPaths = action.changedPaths.slice(
    0,
    COMPACT_STATUS_LIMITS.actionPaths,
  );
  const relatedItemIds = action.relatedItemIds?.slice(
    0,
    COMPACT_STATUS_LIMITS.actionItems,
  );
  const evidenceRefs = action.evidenceRefs?.slice(
    0,
    COMPACT_STATUS_LIMITS.evidenceRefs,
  );
  const omitted = {
    ...(action.changedPaths.length > changedPaths.length
      ? { changedPaths: action.changedPaths.length - changedPaths.length }
      : {}),
    ...(action.relatedItemIds &&
    action.relatedItemIds.length > (relatedItemIds?.length ?? 0)
      ? {
          relatedItemIds:
            action.relatedItemIds.length - (relatedItemIds?.length ?? 0),
        }
      : {}),
    ...(action.evidenceRefs &&
    action.evidenceRefs.length > (evidenceRefs?.length ?? 0)
      ? {
          evidenceRefs:
            action.evidenceRefs.length - (evidenceRefs?.length ?? 0),
        }
      : {}),
  };
  return {
    ...action,
    changedPaths,
    ...(relatedItemIds?.length ? { relatedItemIds } : {}),
    ...(evidenceRefs?.length ? { evidenceRefs } : {}),
    ...(Object.keys(omitted).length ? { omitted } : {}),
  };
}

function buildSyncCacheKey(parts: {
  branch: string | null;
  head: string;
  dirtyHash: string;
  worktreeFingerprint: string;
  snapshotParserRevision: string;
  domainRuleFingerprint: string;
  dbRevision: number;
  evidenceVersion: string;
  mappingVersion: string;
}): { fingerprint: string; cacheKey: string } {
  const fingerprint = [
    parts.branch ?? 'unknown',
    parts.head,
    parts.dirtyHash || 'clean',
    `worktrees:${parts.worktreeFingerprint}`,
    parts.snapshotParserRevision,
    parts.domainRuleFingerprint,
    `db:${parts.dbRevision}`,
    `evidence:${parts.evidenceVersion}`,
    `mappings:${parts.mappingVersion}`,
  ].join('|');
  const cacheKey = createHash('sha256')
    .update(fingerprint)
    .digest('hex')
    .slice(0, 16);
  return { fingerprint, cacheKey };
}

function toActionId(
  action: SyncSuggestedAction['action'],
  worktreeId: string,
  domain?: string,
): string {
  return `${action}:${worktreeId}${domain ? `:${domain}` : ''}`;
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
        WHERE p.project_key = $1 AND w.path = $2 AND w.registered
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
    const normalizedChanges = input.changes
      .map((change, index) => {
        if (!change || typeof change !== 'object' || !('item' in change)) {
          throw new KnowledgeError(
            'VERSION_CONFLICT',
            'Each knowledge change must include an item object',
            false,
            { index },
          );
        }
        const candidate = change as KnowledgeChange;
        if (!candidate.item || typeof candidate.item !== 'object') {
          throw new KnowledgeError(
            'VERSION_CONFLICT',
            'Each knowledge change must include a valid item',
            false,
            { index },
          );
        }
        return candidate;
      });
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
      const requestsVerifiedCompletion = normalizedChanges.some(
        (change) =>
          change.item?.deliveryStatus === 'completed' &&
          change.item?.verificationStatus !== undefined &&
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
      for (const change of normalizedChanges) {
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
    if (!change || typeof change !== 'object' || typeof change.item !== 'object') {
      throw new KnowledgeError(
        'VERSION_CONFLICT',
        'Knowledge change missing item payload',
        false,
      );
    }
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
    if (!change.item.kind && !existing?.kind) {
      throw new KnowledgeError(
        'VERSION_CONFLICT',
        'Knowledge item kind is required',
        false,
      );
    }
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
        `${record.kind}:${title
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
          record.kind,
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
      `INSERT INTO project_knowledge.outbox_jobs
        (project_id,job_type,job_key,required_capability,payload)
      VALUES($1,'embed_chunk', $2,'embedding', $3),
            ($1,'publish_item', $4,'publish', $5)
      ON CONFLICT DO NOTHING`,
      [
        projectId,
        `embed:${chunkId}`,
        { chunkId },
        `publish:${itemId}:${version}`,
        { itemId, version },
      ],
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
      const compact = input.compact ?? true;
      const issueLimit = Math.max(1, Math.min(20, input.issueLimit ?? 10));
      const actionLimit = Math.max(1, Math.min(20, input.actionLimit ?? 10));
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
      const [
        snapshots,
        projections,
        queues,
        conflicts,
        freshness,
        tasks,
        domainStates,
        syncRules,
        mappingAndEvidence,
      ] = await Promise.all([
        this.pool.query<{
          worktree_id: string;
          path: string;
          branch: string;
          head_commit: string;
          dirty_hash: string | null;
          dirty_paths: string[];
          registered: boolean;
          snapshot_id: string;
          snapshot_head: string;
          snapshot_dirty_hash: string | null;
          parser_revision: string | null;
          freshness: Freshness;
        }>(
          `SELECT w.id AS worktree_id,w.path,w.branch,w.head_commit,w.dirty_hash,w.dirty_paths,w.registered,
             s.id AS snapshot_id,s.head_commit AS snapshot_head,s.dirty_hash AS snapshot_dirty_hash,s.parser_revision,
             CASE WHEN s.id IS NOT NULL AND s.head_commit=w.head_commit
               AND s.dirty_hash IS NOT DISTINCT FROM w.dirty_hash THEN 'current' ELSE 'stale' END AS freshness
           FROM project_knowledge.worktrees w
           LEFT JOIN LATERAL (
             SELECT id,head_commit,dirty_hash,parser_revision FROM project_knowledge.source_snapshots
             WHERE worktree_id=w.id AND state='active'
             ORDER BY activated_at DESC NULLS LAST LIMIT 1
           ) s ON true
           WHERE w.project_id=$1 AND w.registered
             AND ($2::uuid[] IS NULL OR w.id=ANY($2))
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
        this.pool.query<DomainSyncRow>(
          `SELECT sync.worktree_id,w.path AS worktree_path,w.branch,
               sync.current_commit,sync.current_dirty_hash,sync.indexed_commit,
               sync.indexed_dirty_hash,sync.source_snapshot_id AS snapshot_id,
               domain.name AS domain,sync.note_path,sync.state,
               sync.last_synced_commit,sync.last_synced_dirty_hash,
               sync.database_revision,sync.projection_revision,sync.reasons,
               sync.changed_paths,sync.evidence_refs,sync.unmapped_paths
             FROM project_knowledge.domain_sync_states sync
             JOIN project_knowledge.domains domain ON domain.id=sync.domain_id
             JOIN project_knowledge.worktrees w ON w.id=sync.worktree_id
             WHERE sync.project_id=$1
               AND ($2::uuid[] IS NULL OR sync.worktree_id=ANY($2))
             ORDER BY w.last_seen_at DESC,domain.name`,
          [row.project_id, input.worktreeIds ?? null],
        ),
        this.pool.query<{
          rule_count: number;
          rule_fingerprint: string | null;
        }>(
          `SELECT COUNT(*)::int AS rule_count,MAX(updated_at)::text AS rule_fingerprint
             FROM project_knowledge.domain_path_rules
             WHERE project_id=$1`,
          [row.project_id],
        ),
        this.pool.query<{
          evidence_count: number;
          mapping_count: number;
          evidence_version: string | null;
          mapping_version: string | null;
        }>(
          `SELECT
               (SELECT COUNT(*)::int FROM project_knowledge.source_evidence WHERE project_id=$1) AS evidence_count,
               (SELECT MAX(id::text) FROM project_knowledge.source_evidence WHERE project_id=$1) AS evidence_version,
               (SELECT COUNT(*)::int FROM project_knowledge.physical_mappings WHERE project_id=$1) AS mapping_count,
               (SELECT MAX(id::text) FROM project_knowledge.physical_mappings WHERE project_id=$1) AS mapping_version`,
          [row.project_id],
        ),
      ]);
      const queueCounts = new Map(
        queues.rows.map((entry) => [entry.state, Number(entry.count)]),
      );
      const domainRows = domainStates.rows;
      const allUnmappedChanges = [
        ...new Set(domainRows.flatMap((candidate) => candidate.unmapped_paths)),
      ].sort();
      const staleSources = snapshots.rows.filter(
        (candidate) => candidate.freshness !== 'current',
      ).length;
      const staleEvidence = freshness.rows
        .filter((candidate) => candidate.state !== 'current')
        .reduce((total, current) => total + Number(current.count), 0);
      const staleProjections = projections.rows.filter(
        (candidate) => candidate.state !== 'current',
      ).length;
      const dirtyWorktrees = snapshots.rows.filter(
        (candidate) =>
          candidate.dirty_hash !== null && candidate.dirty_hash !== '',
      ).length;
      const summary: SyncStatusSummary = {
        dirtyWorktrees,
        staleSources,
        staleEvidence,
        staleProjections,
        pendingJobs: queueCounts.get('pending') ?? 0,
        failedJobs: queueCounts.get('failed') ?? 0,
      };

      const sourceFreshness: Freshness =
        staleSources ||
        allUnmappedChanges.length ||
        staleEvidence ||
        staleProjections ||
        dirtyWorktrees ||
        summary.pendingJobs ||
        summary.failedJobs
          ? 'stale'
          : 'current';

      const selectedWorktreeId =
        input.worktreeIds?.[0] ??
        snapshots.rows[0]?.worktree_id ??
        domainRows[0]?.worktree_id;
      const selectedDomains = selectedWorktreeId
        ? domainRows.filter(
            (candidate) => candidate.worktree_id === selectedWorktreeId,
          )
        : [];
      const worktreeRowsForResponse = input.changedOnly
        ? selectedDomains.filter((candidate) => candidate.state !== 'current')
        : selectedDomains;
      const displayedDomainRows = compact
        ? worktreeRowsForResponse.slice(0, COMPACT_STATUS_LIMITS.domains)
        : worktreeRowsForResponse;
      const selectedUnmappedChanges = [
        ...new Set(
          selectedDomains.flatMap((candidate) => candidate.unmapped_paths),
        ),
      ].sort();
      const projectUnmappedChanges = compact
        ? allUnmappedChanges
        : selectedUnmappedChanges;
      const displayedUnmappedChanges = compact
        ? projectUnmappedChanges.slice(0, COMPACT_STATUS_LIMITS.unmappedChanges)
        : projectUnmappedChanges;
      const omittedDomainDetails = compact
        ? {
            ...(worktreeRowsForResponse.length > displayedDomainRows.length
              ? {
                  domains:
                    worktreeRowsForResponse.length - displayedDomainRows.length,
                }
              : {}),
            ...(() => {
              const total = worktreeRowsForResponse.reduce(
                (count, domain) => count + domain.reasons.length,
                0,
              );
              const shown = displayedDomainRows.reduce(
                (count, domain) =>
                  count +
                  Math.min(
                    domain.reasons.length,
                    COMPACT_STATUS_LIMITS.reasons,
                  ),
                0,
              );
              return total > shown ? { reasons: total - shown } : {};
            })(),
            ...(() => {
              const total = worktreeRowsForResponse.reduce(
                (count, domain) => count + domain.changed_paths.length,
                0,
              );
              const shown = displayedDomainRows.reduce(
                (count, domain) =>
                  count +
                  Math.min(
                    domain.changed_paths.length,
                    COMPACT_STATUS_LIMITS.domainPaths,
                  ),
                0,
              );
              return total > shown ? { changedPaths: total - shown } : {};
            })(),
            ...(() => {
              const total = worktreeRowsForResponse.reduce(
                (count, domain) => count + domain.evidence_refs.length,
                0,
              );
              const shown = displayedDomainRows.reduce(
                (count, domain) =>
                  count +
                  Math.min(
                    domain.evidence_refs.length,
                    COMPACT_STATUS_LIMITS.domainEvidenceRefs,
                  ),
                0,
              );
              return total > shown ? { evidenceRefs: total - shown } : {};
            })(),
            ...(projectUnmappedChanges.length > displayedUnmappedChanges.length
              ? {
                  unmappedChanges:
                    projectUnmappedChanges.length -
                    displayedUnmappedChanges.length,
                }
              : {}),
          }
        : {};
      const sampleDomainRow =
        displayedDomainRows[0] ?? selectedDomains[0] ?? domainRows[0];
      const domainSync = sampleDomainRow
        ? {
            worktreeId: sampleDomainRow.worktree_id,
            worktreePath: sampleDomainRow.worktree_path,
            branch: sampleDomainRow.branch,
            currentCommit: sampleDomainRow.current_commit,
            ...(sampleDomainRow.current_dirty_hash
              ? { currentDirtyHash: sampleDomainRow.current_dirty_hash }
              : {}),
            ...(sampleDomainRow.indexed_commit
              ? { indexedCommit: sampleDomainRow.indexed_commit }
              : {}),
            ...(sampleDomainRow.indexed_dirty_hash
              ? { indexedDirtyHash: sampleDomainRow.indexed_dirty_hash }
              : {}),
            ...(sampleDomainRow.snapshot_id
              ? { snapshotId: sampleDomainRow.snapshot_id }
              : {}),
            domains: displayedDomainRows.map((domain) => ({
              name: domain.domain,
              notePath: domain.note_path,
              state: domain.state,
              ...(domain.last_synced_commit
                ? { lastSyncedCommit: domain.last_synced_commit }
                : {}),
              ...(domain.last_synced_dirty_hash
                ? { lastSyncedDirtyHash: domain.last_synced_dirty_hash }
                : {}),
              currentCommit: domain.current_commit,
              ...(domain.current_dirty_hash
                ? { currentDirtyHash: domain.current_dirty_hash }
                : {}),
              databaseRevision: Number(domain.database_revision),
              ...(domain.projection_revision !== null
                ? { projectionRevision: Number(domain.projection_revision) }
                : {}),
              reasons: compact
                ? domain.reasons.slice(0, COMPACT_STATUS_LIMITS.reasons)
                : domain.reasons,
              changedPaths: compact
                ? domain.changed_paths.slice(
                    0,
                    COMPACT_STATUS_LIMITS.domainPaths,
                  )
                : domain.changed_paths,
              evidenceRefs: compact
                ? domain.evidence_refs.slice(
                    0,
                    COMPACT_STATUS_LIMITS.domainEvidenceRefs,
                  )
                : domain.evidence_refs,
            })),
            unmappedChanges: displayedUnmappedChanges,
            ...(Object.keys(omittedDomainDetails).length
              ? { omitted: omittedDomainDetails }
              : {}),
          }
        : undefined;

      const selectedSnapshot = snapshots.rows[0];
      const worktreeFingerprint = createHash('sha256')
        .update(
          snapshots.rows
            .map((snapshot) =>
              [
                snapshot.worktree_id,
                snapshot.branch,
                snapshot.head_commit,
                snapshot.dirty_hash ?? 'clean',
                snapshot.parser_revision ?? 'legacy',
              ].join(':'),
            )
            .sort()
            .join('|'),
        )
        .digest('hex')
        .slice(0, 16);
      const cacheSeed = buildSyncCacheKey({
        branch: selectedSnapshot?.branch ?? null,
        head: selectedSnapshot?.head_commit ?? 'untracked',
        dirtyHash: selectedSnapshot?.dirty_hash ?? 'clean',
        worktreeFingerprint,
        snapshotParserRevision: selectedSnapshot?.parser_revision ?? 'legacy',
        domainRuleFingerprint: `${syncRules.rows[0]?.rule_count ?? 0}:${syncRules.rows[0]?.rule_fingerprint ?? 'none'}`,
        dbRevision: Number(row.db_revision),
        evidenceVersion: `${mappingAndEvidence.rows[0]?.evidence_count ?? 0}:${mappingAndEvidence.rows[0]?.evidence_version ?? 'none'}`,
        mappingVersion: `${mappingAndEvidence.rows[0]?.mapping_count ?? 0}:${mappingAndEvidence.rows[0]?.mapping_version ?? 'none'}`,
      });
      const cacheKey = `${input.projectKey}|${cacheSeed.cacheKey}|${compact ? 1 : 0}|${input.changedOnly ? 1 : 0}|${issueLimit}|${actionLimit}|${[...(input.worktreeIds ?? [])].sort().join(',')}`;
      const cached = compact ? syncStatusCache.get(cacheKey) : undefined;
      const cacheFresh = Boolean(
        compact &&
        cached &&
        cached.fingerprint === cacheSeed.fingerprint &&
        cached.cacheKey === cacheSeed.cacheKey &&
        cached.expiresAt > Date.now(),
      );

      let topIssues: string[];
      let topSuggestedActions: SyncSuggestedAction[];
      if (cacheFresh && cached) {
        topIssues = cached.topIssues;
        topSuggestedActions = cached.topSuggestedActions;
      } else {
        const issueSeeds: string[] = [];
        if (summary.failedJobs > 0)
          issueSeeds.push(
            `${summary.failedJobs} failed sync job(s) require manual review`,
          );
        if (summary.pendingJobs > 0)
          issueSeeds.push(
            `${summary.pendingJobs} pending sync job(s) have not completed`,
          );
        if (summary.staleEvidence > 0)
          issueSeeds.push(
            `${summary.staleEvidence} stale or missing evidence references`,
          );
        if (summary.staleSources > 0)
          issueSeeds.push(
            `${summary.staleSources} source snapshot(s) are stale`,
          );
        if (allUnmappedChanges.length)
          issueSeeds.push(
            `${allUnmappedChanges.length} changed files are not mapped to a domain`,
          );
        if (summary.staleProjections > 0)
          issueSeeds.push(
            `${summary.staleProjections} projection entries are not current`,
          );

        const changedPathCandidates = new Set<string>();
        for (const candidate of domainRows) {
          if (candidate.state !== 'current')
            for (const path of candidate.changed_paths)
              changedPathCandidates.add(path);
          for (const path of candidate.unmapped_paths)
            changedPathCandidates.add(path);
        }
        for (const snapshot of snapshots.rows)
          if (snapshot.freshness !== 'current')
            for (const path of snapshot.dirty_paths ?? [])
              changedPathCandidates.add(path);

        const evidenceLookup = changedPathCandidates.size
          ? (
              await this.pool.query<SyncEvidenceLookupRow>(
                `SELECT evidence.source_path,evidence.item_id,item.stable_key,item.title
                 FROM project_knowledge.source_evidence evidence
                 JOIN project_knowledge.knowledge_items item ON item.id=evidence.item_id
                 WHERE evidence.project_id=$1 AND evidence.source_path=ANY($2::text[])`,
                [row.project_id, [...changedPathCandidates]],
              )
            ).rows
          : [];
        const pathToItemIds = new Map<string, string[]>();
        for (const match of evidenceLookup) {
          const prior = pathToItemIds.get(match.source_path) ?? [];
          pathToItemIds.set(match.source_path, [
            ...new Set([...prior, match.item_id]),
          ]);
        }

        const pathActions = new Map<string, SyncSuggestedAction>();
        for (const domain of domainRows) {
          const changedPaths = [...new Set(domain.changed_paths)].sort();
          const evidenceRefs = [...new Set(domain.evidence_refs)].sort();
          if (changedPaths.length > 0) {
            const reindexActionId = toActionId(
              'REINDEX_SOURCE',
              domain.worktree_id,
              domain.domain,
            );
            if (!pathActions.has(reindexActionId)) {
              const relatedItemIds = [
                ...new Set(
                  changedPaths.flatMap((path) => pathToItemIds.get(path) ?? []),
                ),
              ];
              pathActions.set(reindexActionId, {
                actionId: reindexActionId,
                action: 'REINDEX_SOURCE',
                summary: `Reindex changed source paths for ${domain.domain}`,
                worktreeId: domain.worktree_id,
                worktreePath: domain.worktree_path,
                domain: domain.domain,
                changedPaths,
                ...(relatedItemIds.length ? { relatedItemIds } : {}),
                estimatedWrites: changedPaths.length,
                estimatedTokens: tokenEstimate({
                  pathCount: changedPaths.length,
                  itemCount: relatedItemIds.length,
                }),
              });
            }
          }

          if (domain.unmapped_paths.length > 0) {
            const unmappedActionId = toActionId(
              'REINDEX_SOURCE',
              domain.worktree_id,
              `${domain.domain}:unmapped`,
            );
            if (!pathActions.has(unmappedActionId)) {
              const relatedItemIds = [
                ...new Set(
                  domain.unmapped_paths.flatMap(
                    (path) => pathToItemIds.get(path) ?? [],
                  ),
                ),
              ];
              pathActions.set(unmappedActionId, {
                actionId: unmappedActionId,
                action: 'REINDEX_SOURCE',
                summary: `Resolve unmapped source paths for ${domain.domain}`,
                worktreeId: domain.worktree_id,
                worktreePath: domain.worktree_path,
                domain: domain.domain,
                changedPaths: [...new Set(domain.unmapped_paths)],
                ...(relatedItemIds.length ? { relatedItemIds } : {}),
                estimatedWrites: domain.unmapped_paths.length,
                estimatedTokens: tokenEstimate({
                  pathCount: domain.unmapped_paths.length,
                  itemCount: relatedItemIds.length,
                }),
              });
            }
          }

          const hasChanged = changedPaths.length > 0;
          const projectionLag =
            domain.projection_revision !== null &&
            domain.projection_revision < domain.database_revision;
          if (domain.state === 'stale' && hasChanged) {
            const actionId = toActionId(
              'UPDATE_KNOWLEDGE',
              domain.worktree_id,
              domain.domain,
            );
            const relatedItemIds = [
              ...new Set(
                changedPaths.flatMap((path) => pathToItemIds.get(path) ?? []),
              ),
            ];
            pathActions.set(actionId, {
              actionId,
              action: 'UPDATE_KNOWLEDGE',
              summary: `Rewrite documentation for ${domain.domain}`,
              worktreeId: domain.worktree_id,
              worktreePath: domain.worktree_path,
              domain: domain.domain,
              changedPaths,
              ...(relatedItemIds.length ? { relatedItemIds } : {}),
              ...(evidenceRefs.length ? { evidenceRefs } : {}),
              estimatedWrites: Math.max(1, changedPaths.length),
              estimatedTokens: tokenEstimate({
                pathCount: changedPaths.length,
                itemCount: relatedItemIds.length,
              }),
              dependsOn: [
                toActionId('REINDEX_SOURCE', domain.worktree_id, domain.domain),
              ],
            });
            continue;
          }
          if (
            domain.state === 'missing' ||
            domain.state === 'unverified' ||
            domain.state === 'possibly_stale' ||
            (domain.state === 'stale' &&
              domain.reasons.some((reason) =>
                /evidence|authoritative ref/iu.test(reason),
              ))
          ) {
            const verifyActionId = toActionId(
              'VERIFY_EVIDENCE',
              domain.worktree_id,
              domain.domain,
            );
            const targetPaths = [
              ...new Set([...changedPaths, ...domain.unmapped_paths]),
            ];
            const relatedItemIds = [
              ...new Set(
                targetPaths.flatMap((path) => pathToItemIds.get(path) ?? []),
              ),
            ];
            pathActions.set(verifyActionId, {
              actionId: verifyActionId,
              action: 'VERIFY_EVIDENCE',
              summary: `Verify evidence for ${domain.domain}`,
              worktreeId: domain.worktree_id,
              worktreePath: domain.worktree_path,
              domain: domain.domain,
              changedPaths: targetPaths,
              ...(relatedItemIds.length ? { relatedItemIds } : {}),
              ...(evidenceRefs.length ? { evidenceRefs } : {}),
              estimatedWrites: Math.max(
                1,
                relatedItemIds.length,
                evidenceRefs.length,
              ),
              estimatedTokens: tokenEstimate({
                pathCount: targetPaths.length,
                itemCount: Math.max(relatedItemIds.length, evidenceRefs.length),
              }),
              dependsOn: hasChanged
                ? [
                    toActionId(
                      'REINDEX_SOURCE',
                      domain.worktree_id,
                      domain.domain,
                    ),
                  ]
                : undefined,
            });
            continue;
          }
          if (
            projectionLag &&
            !hasChanged &&
            domain.reasons.every((reason) =>
              /projection|canonical knowledge/iu.test(reason),
            )
          ) {
            const finalizeActionId = toActionId(
              'FINALIZE_PROJECTION',
              domain.worktree_id,
              domain.domain,
            );
            pathActions.set(finalizeActionId, {
              actionId: finalizeActionId,
              action: 'FINALIZE_PROJECTION',
              summary: `Finalize projection for ${domain.domain}`,
              worktreeId: domain.worktree_id,
              worktreePath: domain.worktree_path,
              domain: domain.domain,
              changedPaths: [],
              estimatedWrites: 1,
              estimatedTokens: 180,
            });
          }
        }

        for (const snapshot of snapshots.rows) {
          if (snapshot.freshness === 'current') continue;
          const fallbackActionId = toActionId(
            'REINDEX_SOURCE',
            snapshot.worktree_id,
            'source',
          );
          if (
            [...pathActions.values()].some(
              (candidate) =>
                candidate.action === 'REINDEX_SOURCE' &&
                candidate.worktreeId === snapshot.worktree_id,
            )
          )
            continue;
          const changedPaths = [...new Set(snapshot.dirty_paths ?? [])].sort();
          const relatedItemIds = [
            ...new Set(
              changedPaths.flatMap(
                (sourcePath) => pathToItemIds.get(sourcePath) ?? [],
              ),
            ),
          ];
          pathActions.set(fallbackActionId, {
            actionId: fallbackActionId,
            action: 'REINDEX_SOURCE',
            summary: `Refresh stale source snapshot for ${snapshot.branch}`,
            worktreeId: snapshot.worktree_id,
            worktreePath: snapshot.path,
            changedPaths,
            ...(relatedItemIds.length ? { relatedItemIds } : {}),
            estimatedWrites: Math.max(1, changedPaths.length),
            estimatedTokens: tokenEstimate({
              pathCount: changedPaths.length,
              itemCount: relatedItemIds.length,
            }),
          });
        }

        if (
          summary.pendingJobs > 0 &&
          ![...pathActions.values()].some(
            (candidate) => candidate.action === 'FINALIZE_PROJECTION',
          )
        ) {
          const worktreeId = selectedSnapshot?.worktree_id ?? row.project_id;
          const finalizeActionId = toActionId(
            'FINALIZE_PROJECTION',
            worktreeId,
            'pending-jobs',
          );
          pathActions.set(finalizeActionId, {
            actionId: finalizeActionId,
            action: 'FINALIZE_PROJECTION',
            summary: `Process ${summary.pendingJobs} pending worker job(s)`,
            worktreeId,
            ...(selectedSnapshot?.path
              ? { worktreePath: selectedSnapshot.path }
              : {}),
            changedPaths: [],
            estimatedWrites: summary.pendingJobs,
            estimatedTokens: 180,
          });
        }

        const actionPriority: Record<SyncSuggestedAction['action'], number> = {
          REINDEX_SOURCE: 0,
          UPDATE_KNOWLEDGE: 1,
          VERIFY_EVIDENCE: 2,
          FINALIZE_PROJECTION: 3,
        };
        topSuggestedActions = [...pathActions.values()]
          .sort((left, right) =>
            actionPriority[left.action] === actionPriority[right.action]
              ? (left.domain ?? '').localeCompare(right.domain ?? '') ||
                left.worktreeId.localeCompare(right.worktreeId)
              : actionPriority[left.action] - actionPriority[right.action],
          )
          .slice(0, actionLimit);
        topIssues = issueSeeds.slice(0, issueLimit);
        syncStatusCache.set(cacheKey, {
          expiresAt: Date.now() + SYNC_STATUS_CACHE_TTL_MS,
          cacheKey: cacheSeed.cacheKey,
          fingerprint: cacheSeed.fingerprint,
          summary,
          topIssues,
          topSuggestedActions,
        });
      }

      const response: ProjectSyncStatus = {
        projectKey: input.projectKey,
        dbRevision: Number(row.db_revision),
        sourceFreshness,
        summary,
        topIssues,
        topSuggestedActions: topSuggestedActions
          .slice(0, actionLimit)
          .map((action) => (compact ? compactSuggestedAction(action) : action)),
        cacheKey: cacheSeed.cacheKey,
        fingerprint: cacheSeed.fingerprint,
        compact,
        snapshots: compact
          ? snapshots.rows
              .slice(0, COMPACT_STATUS_LIMITS.snapshots)
              .map((snapshot) => ({
                ...snapshot,
                dirty_paths: (snapshot.dirty_paths ?? []).slice(
                  0,
                  COMPACT_STATUS_LIMITS.snapshotPaths,
                ),
                ...((snapshot.dirty_paths?.length ?? 0) >
                COMPACT_STATUS_LIMITS.snapshotPaths
                  ? {
                      omitted_dirty_paths:
                        snapshot.dirty_paths.length -
                        COMPACT_STATUS_LIMITS.snapshotPaths,
                    }
                  : {}),
              }))
          : snapshots.rows,
        projections: compact
          ? projections.rows.slice(0, COMPACT_STATUS_LIMITS.projections)
          : projections.rows,
        queues: {
          pending: queueCounts.get('pending') ?? 0,
          failed: queueCounts.get('failed') ?? 0,
        },
        conflicts: compact
          ? conflicts.rows.slice(0, COMPACT_STATUS_LIMITS.conflicts)
          : conflicts.rows,
        documentationFreshness: Object.fromEntries(
          freshness.rows.map((entry) => [entry.state, Number(entry.count)]),
        ),
        tasks: compact
          ? tasks.rows.slice(0, COMPACT_STATUS_LIMITS.tasks)
          : tasks.rows,
        ...(domainSync ? { domainSync } : {}),
      };

      return response;
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
