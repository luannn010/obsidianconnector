import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  auditDomainSync,
  parseDomainManifest,
  type DomainFreshness,
  type DomainPathRule,
} from '../knowledge/domain-sync.js';

interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface DomainSyncReport {
  worktreeId: string;
  worktreePath: string;
  branch: string;
  currentCommit: string;
  currentDirtyHash?: string;
  indexedCommit?: string;
  indexedDirtyHash?: string;
  snapshotId?: string;
  domains: Array<{
    name: string;
    notePath: string;
    state: DomainFreshness;
    lastSyncedCommit?: string;
    lastSyncedDirtyHash?: string;
    currentCommit: string;
    currentDirtyHash?: string;
    databaseRevision: number;
    projectionRevision?: number;
    reasons: string[];
    changedPaths: string[];
    evidenceRefs: string[];
  }>;
  unmappedChanges: string[];
}

function missingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

export async function importDomainManifest(
  database: Queryable,
  projectId: string,
  repositoryPath: string,
): Promise<DomainPathRule[]> {
  const manifestPath = path.join(
    repositoryPath,
    '.project-knowledge',
    'domains.json',
  );
  const content = await readFile(manifestPath, 'utf8').catch((error) => {
    if (missingFile(error)) return undefined;
    throw error;
  });
  if (!content) return [];

  const rules = parseDomainManifest(content);
  await database.query(
    "DELETE FROM project_knowledge.domain_path_rules WHERE project_id=$1 AND source='manifest'",
    [projectId],
  );
  const domainIds = new Map<string, string>();
  for (const domain of [...new Set(rules.map((rule) => rule.domain))]) {
    const row = (
      await database.query<{ id: string }>(
        `INSERT INTO project_knowledge.domains(project_id,name) VALUES($1,$2)
         ON CONFLICT(project_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [projectId, domain],
      )
    ).rows[0]!;
    domainIds.set(domain, row.id);
  }
  for (const rule of rules) {
    await database.query(
      `INSERT INTO project_knowledge.domain_path_rules
       (project_id,domain_id,path_glob,exclusions,source)
       VALUES($1,$2,$3,$4,'manifest')
       ON CONFLICT(domain_id,path_glob) DO UPDATE SET exclusions=EXCLUDED.exclusions,
         source='manifest',updated_at=now()`,
      [projectId, domainIds.get(rule.domain), rule.pattern, rule.exclusions ?? []],
    );
  }
  return rules;
}

function noteName(domain: string): string {
  return domain.replace(/[\\/:*?"<>|]/gu, '-');
}

export async function buildDomainSyncReport(
  database: Queryable,
  input: {
    projectId: string;
    repositoryPath: string;
    databaseRevision: number;
  },
): Promise<DomainSyncReport | undefined> {
  const worktree = (
    await database.query<{
      id: string;
      path: string;
      branch: string;
      head_commit: string;
      dirty_hash: string | null;
      dirty_paths: string[];
      snapshot_id: string | null;
      indexed_commit: string | null;
      indexed_dirty_hash: string | null;
    }>(
      `SELECT w.id,w.path,w.branch,w.head_commit,w.dirty_hash,w.dirty_paths,
         snapshot.id AS snapshot_id,snapshot.head_commit AS indexed_commit,
         snapshot.dirty_hash AS indexed_dirty_hash
       FROM project_knowledge.worktrees w
       LEFT JOIN LATERAL (
         SELECT s.id,s.head_commit,s.dirty_hash FROM project_knowledge.source_snapshots s
         WHERE s.worktree_id=w.id AND s.state='active'
         ORDER BY s.activated_at DESC NULLS LAST LIMIT 1
       ) snapshot ON true
       WHERE w.project_id=$1 AND w.path=$2`,
      [input.projectId, path.resolve(input.repositoryPath)],
    )
  ).rows[0];
  if (!worktree) return undefined;

  const rules = (
    await database.query<{
      domain: string;
      path_glob: string;
      exclusions: string[];
    }>(
      `SELECT domain.name AS domain,rules.path_glob,rules.exclusions
       FROM project_knowledge.domain_path_rules rules
       JOIN project_knowledge.domains domain ON domain.id=rules.domain_id
       WHERE rules.project_id=$1 ORDER BY rules.priority,domain.name,rules.path_glob`,
      [input.projectId],
    )
  ).rows.map((rule) => ({
    domain: rule.domain,
    pattern: rule.path_glob,
    exclusions: rule.exclusions,
  }));

  const projectionRows = (
    await database.query<{
      domain: string;
      relative_path: string | null;
      db_revision: number | null;
      source_snapshot_id: string | null;
      last_synced_commit: string | null;
      last_synced_dirty_hash: string | null;
    }>(
      `SELECT domain.name AS domain,projection.relative_path,projection.db_revision,
         projection.source_snapshot_id,snapshot.head_commit AS last_synced_commit,
         snapshot.dirty_hash AS last_synced_dirty_hash
       FROM project_knowledge.domains domain
       LEFT JOIN project_knowledge.note_projections projection
         ON projection.project_id=domain.project_id AND projection.view_id='domain:'||domain.name
       LEFT JOIN project_knowledge.source_snapshots snapshot ON snapshot.id=projection.source_snapshot_id
       WHERE domain.project_id=$1 ORDER BY domain.name`,
      [input.projectId],
    )
  ).rows;

  const freshnessRows = worktree.snapshot_id
    ? (
        await database.query<{ domain: string; state: DomainFreshness }>(
          `SELECT item.domain,
             CASE max(CASE freshness.state
               WHEN 'missing' THEN 5 WHEN 'stale' THEN 4 WHEN 'possibly_stale' THEN 3
               WHEN 'unverified' THEN 2 ELSE 1 END)
             WHEN 5 THEN 'missing' WHEN 4 THEN 'stale' WHEN 3 THEN 'possibly_stale'
             WHEN 2 THEN 'unverified' ELSE 'current' END AS state
           FROM project_knowledge.documentation_freshness freshness
           JOIN project_knowledge.knowledge_items item ON item.id=freshness.item_id
           WHERE freshness.project_id=$1 AND freshness.worktree_id=$2
             AND freshness.snapshot_id=$3 AND item.domain IS NOT NULL
           GROUP BY item.domain`,
          [input.projectId, worktree.id, worktree.snapshot_id],
        )
      ).rows
    : [];
  const freshness = new Map(freshnessRows.map((row) => [row.domain, row.state]));

  const evidence = (
    await database.query<{ domain: string; path: string; ref: string }>(
      `SELECT DISTINCT item.domain,evidence.source_path AS path,
         'knowledge:'||item.id||':v'||item.current_version AS ref
       FROM project_knowledge.source_evidence evidence
       JOIN project_knowledge.knowledge_items item ON item.id=evidence.item_id
       WHERE evidence.project_id=$1 AND item.domain IS NOT NULL
       UNION
       SELECT DISTINCT chunk.domain,chunk.metadata->>'path' AS path,'chunk:'||chunk.id AS ref
       FROM project_knowledge.search_chunks chunk
       WHERE chunk.project_id=$1 AND chunk.snapshot_id=$2 AND chunk.domain IS NOT NULL
         AND chunk.metadata ? 'path'`,
      [input.projectId, worktree.snapshot_id],
    )
  ).rows;

  const priorSnapshots = [
    ...new Set(
      projectionRows
        .map((row) => row.source_snapshot_id)
        .filter((id): id is string => Boolean(id && id !== worktree.snapshot_id)),
    ),
  ];
  const changedFromSnapshots =
    worktree.snapshot_id && priorSnapshots.length
      ? (
          await database.query<{ path: string }>(
            `SELECT DISTINCT COALESCE(current_file.repo_relative_path,previous_file.repo_relative_path) AS path
             FROM project_knowledge.code_files current_file
             FULL JOIN project_knowledge.code_files previous_file
               ON previous_file.repo_relative_path=current_file.repo_relative_path
              AND previous_file.snapshot_id=ANY($2::uuid[])
             WHERE current_file.snapshot_id=$1
               AND (previous_file.id IS NULL OR current_file.source_hash<>previous_file.source_hash
                    OR current_file.deleted<>previous_file.deleted)
             UNION
             SELECT DISTINCT previous_file.repo_relative_path
             FROM project_knowledge.code_files previous_file
             WHERE previous_file.snapshot_id=ANY($2::uuid[])
               AND NOT EXISTS (SELECT 1 FROM project_knowledge.code_files current_file
                 WHERE current_file.snapshot_id=$1
                   AND current_file.repo_relative_path=previous_file.repo_relative_path)`,
            [worktree.snapshot_id, priorSnapshots],
          )
        ).rows.map((row) => row.path)
      : [];
  const changedPaths = [...new Set([...changedFromSnapshots, ...worktree.dirty_paths])];
  const audit = auditDomainSync({
    currentCommit: worktree.head_commit,
    ...(worktree.dirty_hash ? { currentDirtyHash: worktree.dirty_hash } : {}),
    ...(worktree.indexed_commit ? { indexedCommit: worktree.indexed_commit } : {}),
    ...(worktree.indexed_dirty_hash
      ? { indexedDirtyHash: worktree.indexed_dirty_hash }
      : {}),
    databaseRevision: input.databaseRevision,
    changedPaths,
    rules,
    evidence,
    projections: projectionRows.map((row) => ({
      domain: row.domain,
      notePath:
        row.relative_path ??
        `Published/01 - Architecture/Domains/${noteName(row.domain)}.md`,
      ...(row.db_revision === null
        ? {}
        : { projectionRevision: Number(row.db_revision) }),
      ...(row.last_synced_commit
        ? { lastSyncedCommit: row.last_synced_commit }
        : {}),
      ...(row.last_synced_dirty_hash
        ? { lastSyncedDirtyHash: row.last_synced_dirty_hash }
        : {}),
      evidenceState: freshness.get(row.domain) ?? 'unverified',
    })),
    comparisonComplete: Boolean(
      worktree.snapshot_id &&
        projectionRows.length &&
        projectionRows.every((row) => row.source_snapshot_id),
    ),
  });
  return {
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    branch: worktree.branch,
    currentCommit: worktree.head_commit,
    ...(worktree.dirty_hash ? { currentDirtyHash: worktree.dirty_hash } : {}),
    ...(worktree.indexed_commit ? { indexedCommit: worktree.indexed_commit } : {}),
    ...(worktree.indexed_dirty_hash
      ? { indexedDirtyHash: worktree.indexed_dirty_hash }
      : {}),
    ...(worktree.snapshot_id ? { snapshotId: worktree.snapshot_id } : {}),
    ...audit,
  };
}
