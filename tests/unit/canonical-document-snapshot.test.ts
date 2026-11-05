import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgKnowledgeStore } from '../../src/knowledge/pg-store.js';
import { sourceHash } from '../../src/knowledge/hash.js';
import { KnowledgeWorker } from '../../src/worker/knowledge-worker.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  options: { sourceHash?: string; existing?: boolean } = {},
) {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), 'canonical-snapshot-'),
  );
  temporaryDirectories.push(repositoryPath);
  await mkdir(path.join(repositoryPath, 'docs'));
  await writeFile(
    path.join(repositoryPath, 'docs', 'architecture.md'),
    '# Worktree A architecture',
  );
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes('SELECT p.db_revision')) {
        if (values?.[2] === 'snapshot-other-worktree') return { rows: [] };
        return { rows: [{ db_revision: 2, snapshot_id: 'snapshot-a' }] };
      }
      if (sql.includes('SELECT id FROM project_knowledge.search_chunks'))
        return { rows: [{ id: 'evidence-a' }] };
      if (sql.includes('SELECT source_hash FROM project_knowledge.code_files'))
        return {
          rows: [
            {
              source_hash:
                options.sourceHash ?? sourceHash('# Worktree A architecture'),
            },
          ],
        };
      if (
        options.existing &&
        sql.includes('SELECT i.id,i.current_version,v.canonical_hash')
      )
        return {
          rows: [
            {
              id: 'item-a',
              current_version: 4,
              canonical_hash: 'old-item-hash',
              has_evidence: true,
            },
          ],
        };
      return { rows: [] };
    },
  } as unknown as Pool;
  const write = vi
    .spyOn(PgKnowledgeStore.prototype, 'writeProjectKnowledge')
    .mockResolvedValue({ dbRevision: 3 } as Awaited<
      ReturnType<PgKnowledgeStore['writeProjectKnowledge']>
    >);
  return {
    worker: new KnowledgeWorker(pool),
    project: {
      projectKey: 'project',
      name: 'Project',
      repositoryPath,
      logicalRepositoryPath: 'C:\\projects\\worktree-a',
      vaultPath: repositoryPath,
    },
    queries,
    write,
  };
}

describe('canonical document snapshot binding', () => {
  it('rejects a body changed after its source snapshot was indexed', async () => {
    const { worker, project, write } = await fixture({
      sourceHash: 'old-source-hash',
    });
    await expect(
      worker.syncCanonicalDocuments(project, { snapshotId: 'snapshot-a' }),
    ).rejects.toThrow(/snapshot.*content|content.*snapshot/i);
    expect(write).not.toHaveBeenCalled();
  });

  it('guards the document version without rejecting unrelated project writes', async () => {
    const { worker, project, write } = await fixture({ existing: true });
    await worker.syncCanonicalDocuments(project, { snapshotId: 'snapshot-a' });
    expect(write.mock.calls[0]?.[0]).not.toHaveProperty(
      'expectedProjectRevision',
    );
    expect(write.mock.calls[0]?.[0].changes[0]).toMatchObject({
      expectedVersion: 4,
      expectedHash: 'old-item-hash',
    });
    expect(write.mock.calls[0]?.[0].idempotencyKey).toBeTruthy();
  });
  it('constrains legacy calls to the document worktree instead of the project latest snapshot', async () => {
    const { worker, project, queries, write } = await fixture();
    await expect(worker.syncCanonicalDocuments(project)).resolves.toBe(1);
    const lookup = queries[0]!;
    expect(lookup.values).toEqual([
      'project',
      'C:\\projects\\worktree-a',
      null,
    ]);
    expect(lookup.sql).toContain('s.worktree_id=w.id');
    expect(lookup.sql).toContain('w.path=$2');
    expect(write.mock.calls[0]?.[0].changes[0]?.evidence?.[0]?.snapshotId).toBe(
      'snapshot-a',
    );
  });

  it('uses the reconciled snapshot explicitly and rejects a snapshot from another worktree', async () => {
    const { worker, project, queries, write } = await fixture();
    await expect(
      worker.syncCanonicalDocuments(project, {
        snapshotId: 'snapshot-other-worktree',
      }),
    ).rejects.toThrow(/snapshot/i);
    expect(queries[0]?.values).toEqual([
      'project',
      'C:\\projects\\worktree-a',
      'snapshot-other-worktree',
    ]);
    expect(queries[0]?.sql).toContain('s.id=$3');
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps an explicit reconciled snapshot as the evidence source', async () => {
    const { worker, project, queries, write } = await fixture();
    await worker.syncCanonicalDocuments(project, { snapshotId: 'snapshot-a' });
    expect(queries[0]?.values?.[2]).toBe('snapshot-a');
    expect(write.mock.calls[0]?.[0].changes[0]?.evidence).toEqual([
      {
        snapshotId: 'snapshot-a',
        ref: 'chunk:evidence-a',
        locatorType: 'path',
        required: true,
        verificationScope: 'required',
      },
    ]);
  });
});
