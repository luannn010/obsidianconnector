import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { knowledgeMigrations } from '../../src/knowledge/migrations.js';
import {
  applyKnowledgeMigrations,
  PgKnowledgeStore,
} from '../../src/knowledge/pg-store.js';
import { embeddingHash } from '../../src/knowledge/embed-text.js';
import { EmbeddingQueueProcessor } from '../../src/worker/embedding-queue-processor.js';
import { CachingEmbeddingProvider } from '../../src/knowledge/embedding-cache.js';
import { KnowledgeWorker } from '../../src/worker/knowledge-worker.js';
import { PgEmbeddingCoordinator } from '../../src/knowledge/embedding-coordinator.js';

// This suite mutates only an explicitly supplied, disposable test database.
const databaseUrl = process.env.OBSIDIAN_ISOLATED_TEST_DATABASE_URL;
const model = { name: 'parallel-test', revision: 'r1', dimensions: 384 };
const vector = [1, ...Array<number>(383).fill(0)];
const run = promisify(execFile);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!databaseUrl)('isolated PostgreSQL parallel knowledge', () => {
  let pool: Pool;
  let projectId: string;
  let worktreeId: string;
  let snapshotId: string;
  const projectKey = 'parallel-integration';
  const tempRoots: string[] = [];

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!url.pathname.startsWith('/obsidian_test_')) {
      throw new Error(
        'Refusing to mutate a database without the obsidian_test_ prefix',
      );
    }
    pool = new Pool({
      connectionString: databaseUrl,
      max: 8,
      statement_timeout: 10000,
    });
    await applyKnowledgeMigrations(pool, knowledgeMigrations);
  }, 60000);
  afterAll(async () => {
    await pool?.end();
    for (const root of tempRoots) {
      if (
        path.dirname(root) !== path.resolve(os.tmpdir()) ||
        !path.basename(root).startsWith('obsidian-parallel-')
      ) {
        throw new Error('Refusing to remove an unexpected test directory');
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE project_knowledge.projects CASCADE');
    await pool.query('TRUNCATE project_knowledge.embedding_cache');
    projectId = (
      await pool.query<{ project_id: string }>(
        'INSERT INTO project_knowledge.projects(project_key,name) VALUES($1,$1) RETURNING project_id',
        [projectKey],
      )
    ).rows[0]!.project_id;
    const repositoryId = (
      await pool.query<{ id: string }>(
        `INSERT INTO project_knowledge.repositories(project_id,name,root_path)
       VALUES($1,'test','/test') RETURNING id`,
        [projectId],
      )
    ).rows[0]!.id;
    worktreeId = (
      await pool.query<{ id: string }>(
        `INSERT INTO project_knowledge.worktrees(project_id,repository_id,path,head_commit)
       VALUES($1,$2,'/test','current-head') RETURNING id`,
        [projectId, repositoryId],
      )
    ).rows[0]!.id;
    snapshotId = (
      await pool.query<{ id: string }>(
        `INSERT INTO project_knowledge.source_snapshots(project_id,worktree_id,head_commit,state,activated_at)
       VALUES($1,$2,'current-head','active',now()) RETURNING id`,
        [projectId, worktreeId],
      )
    ).rows[0]!.id;
  });

  async function chunk(
    content: string,
    sourceSnapshot = snapshotId,
    enqueue = true,
  ) {
    const id = randomUUID();
    const hash = embeddingHash(content);
    await pool.query(
      `INSERT INTO project_knowledge.search_chunks
       (id,project_id,snapshot_id,worktree_id,kind,title,content,content_hash,embed_hash,token_count,metadata)
       VALUES($1,$2,$3,$4,'documentation','Guide',$5,$6::text,$6::char(64),10,'{"path":"guide.md"}'::jsonb)`,
      [id, projectId, sourceSnapshot, worktreeId, content, hash],
    );
    let jobId: string | undefined;
    if (enqueue) {
      jobId = (
        await pool.query<{ id: string }>(
          `INSERT INTO project_knowledge.outbox_jobs(project_id,job_type,job_key,required_capability,payload)
         VALUES($1,'embed_chunk',$2,'embedding',$3::jsonb) RETURNING id`,
          [projectId, `embed:${id}`, JSON.stringify({ chunkId: id })],
        )
      ).rows[0]!.id;
    }
    return { id, jobId, hash };
  }

  async function repository() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'obsidian-parallel-'));
    tempRoots.push(root);
    await run('git', ['init', '-q', root]);
    await writeFile(path.join(root, 'a.md'), '# A\n\nInitial document A.\n');
    await writeFile(path.join(root, 'b.md'), '# B\n\nInitial document B.\n');
    await run('git', ['-C', root, 'add', '.']);
    await run('git', [
      '-C',
      root,
      '-c',
      'user.name=Integration Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    return {
      projectKey,
      name: projectKey,
      repositoryPath: root,
      vaultPath: path.join(root, 'vault'),
    };
  }

  it('excludes superseded exact matches by default and preserves explicit historical lookup', async () => {
    const oldSnapshotId = (
      await pool.query<{ id: string }>(
        `INSERT INTO project_knowledge.source_snapshots(project_id,worktree_id,head_commit,state)
       VALUES($1,$2,'old-head','superseded') RETURNING id`,
        [projectId, worktreeId],
      )
    ).rows[0]!.id;
    await chunk('Old guide content', oldSnapshotId, false);
    await chunk('Current guide content', snapshotId, false);
    const store = new PgKnowledgeStore(pool);
    const query = {
      projectKey,
      query: 'guide.md',
      mode: 'exact' as const,
      limit: 10,
      maxTokens: 2000,
    };
    const current = await store.searchProjectContext(query);
    expect(current.results.map((hit) => hit.excerpt)).toEqual([
      'Current guide content',
    ]);
    const historic = await store.searchProjectContext({
      ...query,
      snapshotId: oldSnapshotId,
    });
    expect(historic.results.map((hit) => hit.excerpt)).toEqual([
      'Old guide content',
    ]);
  });

  it('does not publish a vector after another worker acquires the expired claim', async () => {
    const target = await chunk('Lease fencing fixture');
    const started = deferred<void>();
    const finish = deferred<number[][]>();
    const processor = new EmbeddingQueueProcessor(
      pool,
      {
        embed: async () => vector,
        embedMany: async () => {
          started.resolve();
          return finish.promise;
        },
      },
      model,
      { workerId: 'old-worker' },
    );
    const running = processor.processBatch(1);
    await Promise.race([
      started.promise,
      running.then(() => {
        throw new Error('Worker finished before inference');
      }),
    ]);
    await pool.query(
      `UPDATE project_knowledge.outbox_jobs SET lease_owner='new-worker',attempts=attempts+1,
       lease_expires_at=now()+interval '2 minutes' WHERE id=$1`,
      [target.jobId],
    );
    finish.resolve([vector]);
    await running;
    const row = (
      await pool.query<{
        embedding: unknown;
        state: string;
        lease_owner: string;
      }>(
        `SELECT c.embedding,j.state,j.lease_owner FROM project_knowledge.search_chunks c
       JOIN project_knowledge.outbox_jobs j ON j.id=$2 WHERE c.id=$1`,
        [target.id, target.jobId],
      )
    ).rows[0]!;
    expect(row.embedding).toBeNull();
    expect(row.state).toBe('processing');
    expect(row.lease_owner).toBe('new-worker');
  });

  it('does not fail a newer generation when the old inference rejects', async () => {
    const target = await chunk('Failure fencing fixture');
    const started = deferred<void>();
    const finish = deferred<void>();
    const processor = new EmbeddingQueueProcessor(
      pool,
      {
        embed: async () => vector,
        embedMany: async () => {
          started.resolve();
          await finish.promise;
          throw new Error('old inference failed');
        },
      },
      model,
      { workerId: 'same-worker-id' },
    );
    const running = processor.processBatch(1);
    await Promise.race([
      started.promise,
      running.then(() => {
        throw new Error('Worker finished before inference');
      }),
    ]);
    await pool.query(
      `UPDATE project_knowledge.outbox_jobs SET attempts=attempts+1,
       lease_expires_at=now()+interval '2 minutes' WHERE id=$1`,
      [target.jobId],
    );
    finish.resolve();
    await running;
    const row = (
      await pool.query<{
        state: string;
        lease_owner: string;
        attempts: number;
      }>(
        'SELECT state,lease_owner,attempts FROM project_knowledge.outbox_jobs WHERE id=$1',
        [target.jobId],
      )
    ).rows[0]!;
    expect(row.state).toBe('processing');
    expect(row.lease_owner).toBe('same-worker-id');
    expect(row.attempts).toBe(2);
  });

  it('coalesces identical queries across independent providers using the shared database', async () => {
    let calls = 0;
    const modelClient = {
      embed: async () => {
        calls += 1;
        // Simulate external inference latency so all independent clients overlap.
        await new Promise((resolve) => setTimeout(resolve, 100));
        return vector;
      },
    };
    const providers = Array.from(
      { length: 8 },
      () => new CachingEmbeddingProvider(modelClient, pool, model),
    );
    const results = await Promise.all(
      providers.map((provider) =>
        provider.embed('simultaneous knowledge request'),
      ),
    );
    expect(results).toHaveLength(8);
    expect(
      results.every((result) => result.length === 384 && result[0] === 1),
    ).toBe(true);
    expect(calls).toBe(1);
  });

  it('computes one vector when two workers claim equal content in different jobs', async () => {
    await chunk('Shared content between worker jobs');
    await chunk('Shared content between worker jobs');
    let calls = 0;
    const modelClient = {
      embed: async () => vector,
      embedMany: async (texts: string[]) => {
        calls += texts.length;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return texts.map(() => vector);
      },
    };
    await Promise.all(
      ['worker-a', 'worker-b'].map((workerId) =>
        new EmbeddingQueueProcessor(pool, modelClient, model, {
          workerId,
        }).processBatch(1),
      ),
    );
    const rows = (
      await pool.query<{ embedding: unknown }>(
        'SELECT embedding FROM project_knowledge.search_chunks WHERE project_id=$1',
        [projectId],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.embedding !== null)).toBe(true);
    expect(calls).toBe(1);
    const jobs = (
      await pool.query<{ state: string }>(
        "SELECT state FROM project_knowledge.outbox_jobs WHERE project_id=$1 AND job_type='embed_chunk'",
        [projectId],
      )
    ).rows;
    expect(jobs.map((job) => job.state)).toEqual(['done', 'done']);
  });

  it('keeps the vector and version history without another embedding job for metadata-only edits', async () => {
    const store = new PgKnowledgeStore(pool, { embeddingCacheModel: model });
    const created = await store.writeProjectKnowledge({
      projectKey,
      actor: 'codex',
      reason: 'progress',
      message: 'Create metadata fixture',
      idempotencyKey: 'metadata-create',
      changes: [
        {
          operation: 'create',
          item: {
            kind: 'project_note',
            stableKey: 'metadata-fixture',
            title: 'Stable title',
            bodyMarkdown: 'Stable body',
            deliveryStatus: 'planned',
          },
        },
      ],
    });
    const itemId = created.changes[0]!.itemId;
    const modelId = (
      await pool.query<{ id: string }>(
        `INSERT INTO project_knowledge.embedding_models(project_id,model_name,model_revision,dimensions,active)
       VALUES($1,$2,$3,384,true) RETURNING id`,
        [projectId, model.name, model.revision],
      )
    ).rows[0]!.id;
    await pool.query(
      'UPDATE project_knowledge.search_chunks SET embedding=$2::vector,embedding_model_id=$3 WHERE item_id=$1',
      [itemId, `[${vector.join(',')}]`, modelId],
    );
    await pool.query(
      "UPDATE project_knowledge.outbox_jobs SET state='done' WHERE project_id=$1 AND job_type='embed_chunk'",
      [projectId],
    );
    const patched = await store.writeProjectKnowledge({
      projectKey,
      actor: 'codex',
      reason: 'status_change',
      message: 'Update status only',
      idempotencyKey: 'metadata-patch',
      changes: [
        {
          operation: 'patch',
          expectedHash: created.changes[0]!.canonicalHash,
          item: { id: itemId, deliveryStatus: 'completed' },
        },
      ],
    });
    expect(patched.changes[0]!.version).toBe(2);
    const current = (
      await pool.query<{ embedding: unknown; version: number }>(
        `SELECT c.embedding,i.current_version AS version FROM project_knowledge.search_chunks c
       JOIN project_knowledge.knowledge_items i ON i.id=c.item_id WHERE c.item_id=$1 AND c.active`,
        [itemId],
      )
    ).rows[0]!;
    expect(current.embedding).not.toBeNull();
    expect(current.version).toBe(2);
    const jobs = (
      await pool.query<{ count: string }>(
        "SELECT count(*) FROM project_knowledge.outbox_jobs WHERE project_id=$1 AND job_type='embed_chunk'",
        [projectId],
      )
    ).rows[0]!;
    expect(Number(jobs.count)).toBe(1);
  });

  it('allows an unrelated knowledge write while source activation holds its worktree transaction', async () => {
    const project = await repository();
    const paused = deferred<void>();
    const resume = deferred<void>();
    let intercepted = false;
    const stagingPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        const query = client.query.bind(client);
        client.query = (async (sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          if (
            !intercepted &&
            sql.includes('INSERT INTO project_knowledge.source_snapshots')
          ) {
            intercepted = true;
            paused.resolve();
            await resume.promise;
          }
          return result;
        }) as typeof client.query;
        const release = client.release.bind(client);
        client.release = () => {
          client.query = query;
          release();
        };
        return client;
      },
    } as unknown as Pool;
    const source = new KnowledgeWorker(stagingPool, undefined, model).reconcile(
      project,
    );
    await Promise.race([
      paused.promise,
      source.then(() => {
        throw new Error('Source completed before activation barrier');
      }),
    ]);
    const writer = new PgKnowledgeStore(pool, { embeddingCacheModel: model });
    let writeFinished = false;
    const writing = writer
      .writeProjectKnowledge({
        projectKey,
        actor: 'codex',
        reason: 'progress',
        message: 'Concurrent independent note',
        idempotencyKey: 'source-lock-note',
        changes: [
          {
            operation: 'create',
            item: {
              kind: 'project_note',
              stableKey: 'source-lock-note',
              title: 'Independent',
              bodyMarkdown: 'Parallel write',
            },
          },
        ],
      })
      .then(() => {
        writeFinished = true;
      });
    try {
      await Promise.race([
        writing,
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      expect(writeFinished).toBe(true);
    } finally {
      resume.resolve();
      await Promise.all([source, writing]);
    }
  }, 60000);

  it('reuses vectors for a still-dirty unchanged file when another file changes', async () => {
    const project = await repository();
    const worker = new KnowledgeWorker(pool, undefined, model);
    await worker.reconcile(project);
    await writeFile(
      path.join(project.repositoryPath, 'a.md'),
      '# A\n\nUpdated document A.\n',
    );
    await worker.reconcile(project);
    const processor = new EmbeddingQueueProcessor(
      pool,
      {
        embed: async () => vector,
        embedMany: async (texts) => texts.map(() => vector),
      },
      model,
      { workerId: 'source-fixture-embedder' },
    );
    await processor.processBatch(50);
    await writeFile(
      path.join(project.repositoryPath, 'b.md'),
      '# B\n\nUpdated document B.\n',
    );
    const latest = await worker.reconcile(project);
    const rows = (
      await pool.query<{ embedding: unknown }>(
        `SELECT embedding FROM project_knowledge.search_chunks
       WHERE snapshot_id=$1 AND metadata->>'path'='a.md'`,
        [latest.snapshotId],
      )
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.embedding !== null)).toBe(true);
    const jobs = (
      await pool.query<{ count: string }>(
        `SELECT count(*) FROM project_knowledge.outbox_jobs j
       JOIN project_knowledge.search_chunks c ON c.id=(j.payload->>'chunkId')::uuid
       WHERE j.job_type='embed_chunk' AND c.snapshot_id=$1 AND c.metadata->>'path'='a.md'`,
        [latest.snapshotId],
      )
    ).rows[0]!;
    expect(Number(jobs.count)).toBe(0);
  }, 60000);

  it('skips repeated retrieval and invalidates on source and vector changes without a project revision bump', async () => {
    const target = await chunk('Original recalled text', snapshotId, false);
    let searches = 0;
    const measuredPool = {
      connect: pool.connect.bind(pool),
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes('LEFT JOIN LATERAL') && sql.includes('LIMIT 30'))
          searches += 1;
        return pool.query(sql, values);
      },
    };
    const store = new PgKnowledgeStore(measuredPool as unknown as Pool);
    const input = {
      projectKey,
      intent: 'verify' as const,
      query: 'guide.md',
      worktreeId,
      maxTokens: 1200,
    };
    const first = await store.recallProjectKnowledge(input);
    const cached = await store.recallProjectKnowledge({
      ...input,
      knownStateHash: first.stateHash,
    });
    expect(cached.status).toBe('not_modified');
    expect(searches).toBe(1);
    await pool.query(
      "UPDATE project_knowledge.search_chunks SET content='Revised recalled text',content_hash='revised' WHERE id=$1",
      [target.id],
    );
    const changed = await store.recallProjectKnowledge({
      ...input,
      knownStateHash: first.stateHash,
    });
    expect(changed.status).toBe('modified');
    expect(changed.results[0]!.excerpt).toBe('Revised recalled text');
    expect(searches).toBe(2);
    await pool.query(
      'UPDATE project_knowledge.search_chunks SET embedding=$2::vector WHERE id=$1',
      [target.id, JSON.stringify(vector)],
    );
    await store.recallProjectKnowledge({
      ...input,
      knownStateHash: changed.stateHash,
    });
    expect(searches).toBe(3);
    const revision = (
      await pool.query<{ db_revision: string }>(
        'SELECT db_revision FROM project_knowledge.projects WHERE project_id=$1',
        [projectId],
      )
    ).rows[0]!;
    expect(Number(revision.db_revision)).toBe(0);
  });

  it('prevents a stale computation lease from publishing to the shared cache', async () => {
    const coordinator = new PgEmbeddingCoordinator(pool, 384, {
      leaseMs: 1000,
      waitMs: 50,
      pollMs: 5,
    });
    const hash = embeddingHash('stolen computation');
    const started = deferred<void>();
    const finish = deferred<number[]>();
    const computing = coordinator.getOrCompute('lease-test', hash, async () => {
      started.resolve();
      return finish.promise;
    });
    // Attach rejection handling before releasing the deliberately invalidated computation.
    const rejected = expect(computing).rejects.toThrow('timed out');
    await started.promise;
    await pool.query(
      `UPDATE project_knowledge.embedding_compute_leases SET lease_owner=$3,
       lease_expires_at=now()+interval '1 minute' WHERE model_key=$1 AND text_hash=$2`,
      ['lease-test', hash, randomUUID()],
    );
    finish.resolve(vector);
    await rejected;
    const cached = await pool.query(
      'SELECT 1 FROM project_knowledge.embedding_cache WHERE model_key=$1 AND text_hash=$2',
      ['lease-test', hash],
    );
    expect(cached.rows).toHaveLength(0);
    await pool.query(
      'DELETE FROM project_knowledge.embedding_compute_leases WHERE model_key=$1',
      ['lease-test'],
    );
  });

  it('binds canonical document bodies to their own snapshot when another worktree was indexed later', async () => {
    const first = await repository();
    const second = await repository();
    for (const [project, body] of [
      [first, '# Architecture\n\nFirst worktree design.\n'],
      [second, '# Architecture\n\nSecond worktree design.\n'],
    ] as const) {
      await mkdir(path.join(project.repositoryPath, 'docs'));
      await writeFile(
        path.join(project.repositoryPath, 'docs/architecture.md'),
        body,
      );
    }
    const worker = new KnowledgeWorker(pool, undefined, model);
    const firstSnapshot = await worker.reconcile(first);
    const secondSnapshot = await worker.reconcile(second);
    await expect(
      worker.syncCanonicalDocuments(first, {
        snapshotId: secondSnapshot.snapshotId,
      }),
    ).rejects.toThrow('worktree');
    await worker.syncCanonicalDocuments(first, {
      snapshotId: firstSnapshot.snapshotId,
    });
    const row = (
      await pool.query<{ body_markdown: string; snapshot_id: string }>(
        `SELECT v.body_markdown,e.snapshot_id FROM project_knowledge.knowledge_items i
       JOIN project_knowledge.knowledge_versions v ON v.item_id=i.id AND v.version=i.current_version
       JOIN project_knowledge.source_evidence e ON e.knowledge_version_id=v.id
       WHERE i.project_id=$1 AND i.stable_key='architecture:overview'`,
        [projectId],
      )
    ).rows[0]!;
    expect(row.body_markdown).toBe(
      '# Architecture\n\nFirst worktree design.\n',
    );
    expect(row.snapshot_id).toBe(firstSnapshot.snapshotId);
  }, 60000);

  it('scopes lexical freshness by worktree and invalidates recall on freshness-only updates', async () => {
    const store = new PgKnowledgeStore(pool);
    const created = await store.writeProjectKnowledge({
      projectKey,
      actor: 'codex',
      reason: 'progress',
      message: 'Create freshness fixture',
      idempotencyKey: 'freshness-create',
      changes: [
        {
          operation: 'create',
          item: {
            kind: 'project_note',
            stableKey: 'freshness-note',
            title: 'Freshness guide',
            bodyMarkdown: 'parallel freshness guidance',
          },
        },
      ],
    });
    const itemId = created.changes[0]!.itemId;
    const otherWorktree = (
      await pool.query<{ id: string }>(
        `INSERT INTO project_knowledge.worktrees(project_id,repository_id,path,head_commit)
       SELECT project_id,repository_id,'/another','other-head' FROM project_knowledge.worktrees WHERE id=$1 RETURNING id`,
        [worktreeId],
      )
    ).rows[0]!.id;
    const otherSnapshot = (
      await pool.query<{ id: string }>(
        `INSERT INTO project_knowledge.source_snapshots(project_id,worktree_id,head_commit,state,activated_at)
       VALUES($1,$2,'other-head','active',now()) RETURNING id`,
        [projectId, otherWorktree],
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO project_knowledge.documentation_freshness(project_id,item_id,knowledge_version_id,worktree_id,snapshot_id,state,checked_at)
       SELECT $1::uuid,$2::uuid,id,$3::uuid,$4::uuid,'current',now()-interval '1 second' FROM project_knowledge.knowledge_versions WHERE item_id=$2
       UNION ALL SELECT $1::uuid,$2::uuid,id,$5::uuid,$6::uuid,'stale',now() FROM project_knowledge.knowledge_versions WHERE item_id=$2`,
      [projectId, itemId, worktreeId, snapshotId, otherWorktree, otherSnapshot],
    );
    const lexical = await store.searchProjectContext({
      projectKey,
      query: 'parallel',
      mode: 'hybrid',
      worktreeId,
      limit: 10,
      maxTokens: 2000,
    });
    expect(
      lexical.results.find((hit) => hit.itemId === itemId)
        ?.documentationFreshness,
    ).toBe('current');
    const input = {
      projectKey,
      intent: 'verify' as const,
      query: 'Freshness guide',
      worktreeId,
      maxTokens: 1200,
    };
    const first = await store.recallProjectKnowledge(input);
    await pool.query(
      "UPDATE project_knowledge.documentation_freshness SET state='stale' WHERE item_id=$1 AND worktree_id=$2",
      [itemId, worktreeId],
    );
    const changed = await store.recallProjectKnowledge({
      ...input,
      knownStateHash: first.stateHash,
    });
    expect(changed.status).toBe('modified');
    expect(changed.results[0]!.documentationFreshness).toBe('stale');
  });

  it('reports stale bound recalls for HEAD and dirty-content changes', async () => {
    await chunk('Bound snapshot text', snapshotId, false);
    const worktreePath = path.resolve(os.tmpdir(), 'virtual-obsidian-worktree');
    await pool.query(
      'UPDATE project_knowledge.worktrees SET path=$2 WHERE id=$1',
      [worktreeId, worktreePath],
    );
    const store = new PgKnowledgeStore(pool);
    const input = {
      projectKey,
      worktreePath,
      intent: 'verify' as const,
      query: 'guide.md',
      maxTokens: 1200,
    };
    const first = await store.recallProjectKnowledge(input);
    expect(first.freshness).toBe('current');
    await pool.query(
      "UPDATE project_knowledge.worktrees SET head_commit='new-head' WHERE id=$1",
      [worktreeId],
    );
    const headChanged = await store.recallProjectKnowledge({
      ...input,
      knownStateHash: first.stateHash,
    });
    expect(headChanged.freshness).toBe('stale');
    expect(headChanged.status).toBe('modified');
    await pool.query(
      "UPDATE project_knowledge.worktrees SET head_commit='current-head',dirty_hash='dirty-content' WHERE id=$1",
      [worktreeId],
    );
    const dirtyChanged = await store.recallProjectKnowledge({
      ...input,
      knownStateHash: first.stateHash,
    });
    expect(dirtyChanged.freshness).toBe('stale');
    expect(dirtyChanged.status).toBe('modified');
  });

  it('keeps retrieval epoch scope count bounded as a worktree accumulates snapshots', async () => {
    const before = (
      await pool.query<{ count: string; revision: string }>(
        `SELECT count(*),sum(revision) AS revision FROM project_knowledge.retrieval_epochs
       WHERE project_id=$1 AND source_table='source_snapshots'`,
        [projectId],
      )
    ).rows[0]!;
    await pool.query(
      `INSERT INTO project_knowledge.source_snapshots(project_id,worktree_id,head_commit,state)
       SELECT $1::uuid,$2::uuid,'history-'||n,'superseded' FROM generate_series(1,20) n`,
      [projectId, worktreeId],
    );
    const after = (
      await pool.query<{ count: string; revision: string }>(
        `SELECT count(*),sum(revision) AS revision FROM project_knowledge.retrieval_epochs
       WHERE project_id=$1 AND source_table='source_snapshots'`,
        [projectId],
      )
    ).rows[0]!;
    expect(Number(after.count)).toBe(Number(before.count));
    expect(Number(after.revision)).toBeGreaterThan(Number(before.revision));
  });
});
