import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sourceHash } from '../../src/knowledge/hash.js';
import { KnowledgeWorker } from '../../src/worker/knowledge-worker.js';
import {
  changedIndexableFiles,
  fingerprintWorktree,
  listIndexableFiles,
} from '../../src/worker/git-worktree.js';

vi.mock('../../src/worker/git-worktree.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/worker/git-worktree.js')
  >()),
  fingerprintWorktree: vi.fn(),
  changedIndexableFiles: vi.fn(),
  listIndexableFiles: vi.fn(),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), 'source-staging-'),
  );
  directories.push(repositoryPath);
  const unchanged = 'export function unchanged() { return 1; }';
  await writeFile(path.join(repositoryPath, 'a.ts'), unchanged);
  await writeFile(
    path.join(repositoryPath, 'b.ts'),
    'export function changed() { return 2; }',
  );
  const fingerprint = {
    root: repositoryPath,
    branch: 'main',
    head: 'head',
    dirtyHash: 'new-dirty',
    status: ' M a.ts\n M b.ts',
  };
  vi.mocked(fingerprintWorktree).mockResolvedValue(fingerprint);
  const prior = {
    id: 'previous',
    head_commit: 'head',
    dirty_hash: 'old-dirty',
    dirty_paths: ['a.ts'],
    parser_revision: 'structural-v3',
  };
  const state = {
    transaction: false,
    discoveryInTransaction: false,
    prior,
    replacementSnapshotId: undefined as string | undefined,
  };
  vi.mocked(changedIndexableFiles).mockImplementation(async () => {
    state.discoveryInTransaction = state.transaction;
    return [
      { status: 'M', path: 'a.ts' },
      { status: 'M', path: 'b.ts' },
    ];
  });
  vi.mocked(listIndexableFiles).mockResolvedValue(['a.ts', 'b.ts']);
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const query = async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    if (sql === 'BEGIN') state.transaction = true;
    if (sql === 'COMMIT' || sql === 'ROLLBACK') state.transaction = false;
    if (
      sql.includes('SELECT') &&
      sql.includes('head_commit') &&
      sql.includes('source_snapshots') &&
      !sql.includes('INSERT')
    )
      return {
        rows: [
          {
            ...state.prior,
            ...(state.transaction && state.replacementSnapshotId
              ? { id: state.replacementSnapshotId }
              : {}),
          },
        ],
      };
    if (sql.startsWith('SELECT repo_relative_path,source_hash'))
      return {
        rows: [
          { repo_relative_path: 'a.ts', source_hash: sourceHash(unchanged) },
          { repo_relative_path: 'b.ts', source_hash: 'different' },
        ],
      };
    if (
      sql.includes('RETURNING project_id') ||
      sql.startsWith('SELECT project_id FROM')
    )
      return { rows: [{ project_id: 'project-id' }] };
    if (
      sql.includes('RETURNING id') ||
      sql.startsWith('SELECT id FROM project_knowledge.repositories')
    )
      return { rows: [{ id: 'new-id' }] };
    return { rows: [] };
  };
  const pool = {
    query,
    connect: async () => ({ query, release() {} }),
  } as unknown as Pool;
  return {
    worker: new KnowledgeWorker(pool),
    project: {
      projectKey: 'project',
      name: 'Project',
      repositoryPath,
      vaultPath: repositoryPath,
    },
    queries,
    state,
    fingerprint,
  };
}

describe('source snapshot staging', () => {
  it('uses the runtime default small model for source vector reuse', async () => {
    const { worker, project, queries } = await fixture();
    await worker.reconcile(project);
    const reuse = queries.find(({ sql }) =>
      sql.includes('target SET embedding=source.embedding'),
    );
    expect(reuse?.values?.slice(1)).toEqual([
      'BAAI/bge-small-en-v1.5',
      'local',
      384,
    ]);
  });
  it('reuses an unchanged snapshot without loading its file inventory', async () => {
    const { worker, project, state, fingerprint, queries } = await fixture();
    state.prior.dirty_hash = fingerprint.dirtyHash;
    expect(await worker.reconcile(project)).toMatchObject({
      changed: false,
      snapshotId: 'previous',
      indexedFiles: 0,
    });
    expect(
      queries.some(({ sql }) =>
        sql.startsWith('SELECT repo_relative_path,source_hash'),
      ),
    ).toBe(false);
  });

  it('discovers source changes before taking database write locks and skips unchanged dirty bytes', async () => {
    const { worker, project, state } = await fixture();
    const result = await worker.reconcile(project);
    expect(state.discoveryInTransaction).toBe(false);
    expect(result.indexedFiles).toBe(1);
  });

  it('does not rewrite existing project or repository rows during source activation', async () => {
    const { worker, project, queries } = await fixture();
    await worker.reconcile(project);
    expect(
      queries.some(({ sql }) =>
        sql.includes('INSERT INTO project_knowledge.projects'),
      ),
    ).toBe(false);
    expect(
      queries.some(({ sql }) =>
        sql.includes('INSERT INTO project_knowledge.repositories'),
      ),
    ).toBe(false);
    expect(
      queries.some(({ sql }) => sql.includes('pg_advisory_xact_lock')),
    ).toBe(true);
  });

  it('rejects staged bytes before writing after the worktree changes', async () => {
    const { worker, project, queries, fingerprint } = await fixture();
    vi.mocked(fingerprintWorktree)
      .mockResolvedValueOnce(fingerprint)
      .mockResolvedValue({ ...fingerprint, dirtyHash: 'changed-again' });
    await expect(worker.reconcile(project)).rejects.toThrow(/changed during/i);
    expect(queries.some(({ sql }) => sql === 'COMMIT')).toBe(false);
  });

  it('reparses every current file when the parser revision changes', async () => {
    const { worker, project, state, queries } = await fixture();
    state.prior.parser_revision = 'old-parser';
    expect((await worker.reconcile(project)).indexedFiles).toBe(2);
    expect(
      queries.some(({ sql }) =>
        sql.includes('SELECT gen_random_uuid(),project_id,$2'),
      ),
    ).toBe(false);
  });

  it('rolls back database writes if the fingerprint changes before activation', async () => {
    const { worker, project, queries, fingerprint } = await fixture();
    vi.mocked(fingerprintWorktree)
      .mockResolvedValueOnce(fingerprint)
      .mockResolvedValueOnce(fingerprint)
      .mockResolvedValue({
        ...fingerprint,
        dirtyHash: 'changed-after-inserts',
      });
    await expect(worker.reconcile(project)).rejects.toThrow(/changed during/i);
    expect(queries.some(({ sql }) => sql === 'ROLLBACK')).toBe(true);
    expect(queries.some(({ sql }) => sql.includes("SET state='active'"))).toBe(
      false,
    );
  });

  it('rejects staged changes if another runner activated a newer snapshot', async () => {
    const { worker, project, state, queries } = await fixture();
    state.replacementSnapshotId = 'newer-snapshot';
    await expect(worker.reconcile(project)).rejects.toThrow(
      /snapshot changed during staging/i,
    );
    expect(queries.some(({ sql }) => sql === 'ROLLBACK')).toBe(true);
    expect(
      queries.some(({ sql }) =>
        sql.includes('INSERT INTO project_knowledge.source_snapshots'),
      ),
    ).toBe(false);
  });
});
