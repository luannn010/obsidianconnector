import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { EmbeddingQueueProcessor } from '../../src/worker/embedding-queue-processor.js';

interface JobRow {
  id: string;
  chunk_id: string;
  project_id: string;
  content: string;
  content_hash: string;
  embed_hash: string | null;
  attempts?: number;
}

function harness(options: {
  jobs?: JobRow[];
  cached?: Array<{ text_hash: string; embedding: unknown }>;
  sweep?: Record<string, number>;
  reenqueued?: number;
  applied?: number;
  embedMany?: (texts: string[]) => Promise<number[][]>;
  orphanRepairIntervalMs?: number;
  now?: () => number;
  owned?: boolean;
  failFirstApply?: boolean;
  targetProjects?: string[];
}) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const jobs = options.jobs ?? [];
  let failApply = options.failFirstApply ?? false;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes('AS retired_superseded'))
        return { rows: [{ ...(options.sweep ?? {}) }] };
      if (sql.includes('AS reenqueued'))
        return { rows: [{ reenqueued: options.reenqueued ?? 0 }] };
      if (
        sql.includes(
          'INSERT INTO project_knowledge.worker_maintenance_schedule',
        )
      )
        return { rows: [{ task_key: 'embedding-orphan-repair' }] };
      if (sql.includes('RETURNING jobs.id')) return { rows: jobs };
      if (sql.startsWith('SELECT j.id FROM project_knowledge.outbox_jobs j'))
        return { rows: options.owned === false ? [] : jobs };
      if (sql.includes('SELECT text_hash,embedding'))
        return { rows: options.cached ?? [] };
      if (
        sql.includes(
          'INSERT INTO project_knowledge.embedding_compute_leases',
        ) ||
        sql.includes('INSERT INTO project_knowledge.embedding_cache')
      )
        return {
          rows: (values?.[1] as string[]).map((text_hash) => ({ text_hash })),
        };
      if (sql.includes('SELECT DISTINCT project_id'))
        return {
          rows: (
            options.targetProjects ?? [
              ...new Set(jobs.map(({ project_id }) => project_id)),
            ]
          ).map((project_id) => ({ project_id })),
        };
      if (sql.includes('INSERT INTO project_knowledge.embedding_models'))
        return { rows: [{ id: `model-${String(values?.[0])}` }] };
      if (sql.includes('SELECT count(*) AS applied'))
        if (failApply) {
          failApply = false;
          throw new Error('publication rolled back');
        } else return { rows: [{ applied: options.applied ?? jobs.length }] };
      return { rows: [] };
    },
    release: vi.fn(),
  };
  const embedder = {
    embed: vi.fn(async () => [0.1, 0.2, 0.3]),
    embedMany: vi.fn(options.embedMany ?? (async () => [[0.1, 0.2, 0.3]])),
  };
  const processor = new EmbeddingQueueProcessor(
    { connect: async () => client, query: client.query } as unknown as Pool,
    embedder,
    { name: 'test-model', revision: 'r1', dimensions: 3 },
    {
      orphanRepairIntervalMs: options.orphanRepairIntervalMs,
      now: options.now,
    },
  );
  return { processor, embedder, queries };
}

describe('EmbeddingQueueProcessor', () => {
  const leasedJob: JobRow = {
    id: 'job-1',
    chunk_id: 'chunk-1',
    project_id: 'project-1',
    content: 'content',
    content_hash: 'content-hash',
    embed_hash: 'hash-a',
    attempts: 2,
  };

  it('recreates model identity after a publication transaction rolls back', async () => {
    const { processor, queries } = harness({
      jobs: [leasedJob],
      failFirstApply: true,
    });
    await expect(processor.processBatch(1)).resolves.toMatchObject({
      failed: 1,
    });
    await expect(processor.processBatch(1)).resolves.toMatchObject({
      applied: 1,
      failed: 0,
    });
    expect(
      queries.filter(({ sql }) =>
        sql.startsWith('INSERT INTO project_knowledge.embedding_models'),
      ),
    ).toHaveLength(2);
  });

  it('creates cold project model rows in deterministic order across batches', async () => {
    for (const targetProjects of [
      ['project-b', 'project-a'],
      ['project-a', 'project-b'],
    ]) {
      const { processor, queries } = harness({
        jobs: [leasedJob],
        targetProjects,
      });
      await processor.processBatch(1);
      expect(
        queries
          .filter(({ sql }) =>
            sql.startsWith('INSERT INTO project_knowledge.embedding_models'),
          )
          .map(({ values }) => values?.[0]),
      ).toEqual(['project-a', 'project-b']);
    }
  });

  it('completes its locked job when another owner already published a compatible vector', async () => {
    const { processor, queries } = harness({ jobs: [leasedJob], applied: 0 });
    await expect(processor.processBatch(1)).resolves.toMatchObject({
      applied: 0,
      failed: 0,
    });
    const apply = queries.find(({ sql }) => sql.includes('WITH vector_data'))!;
    expect(apply.sql).toContain('completed_chunks AS');
    expect(apply.sql).toContain('FROM completed_chunks chunk');
    expect(apply.sql).toContain('c.embedding_model_id=model.model_id');
  });

  it('does not publish vectors after its job ownership is lost', async () => {
    const { processor, queries } = harness({ jobs: [leasedJob], owned: false });
    await expect(processor.processBatch(1)).resolves.toMatchObject({
      applied: 0,
    });
    expect(queries.some(({ sql }) => sql.includes('WITH vector_data'))).toBe(
      false,
    );
  });

  it('fences failure by owner, claim generation and unexpired processing lease', async () => {
    const { processor, queries } = harness({
      jobs: [leasedJob],
      embedMany: async () => {
        throw new Error('offline');
      },
    });
    await processor.processBatch(1);
    const failure = queries.find(({ sql }) => sql.includes('power(2'))!;
    expect(failure.sql).toContain("state='processing'");
    expect(failure.sql).toContain('lease_owner=$3');
    expect(failure.sql).toContain('attempts=claim.attempt');
    expect(failure.sql).toContain('lease_expires_at>now()');
    expect(failure.values?.[3]).toEqual([2]);
  });

  it('locks valid claims before publication and protects chunks changed during inference', async () => {
    const { processor, queries } = harness({ jobs: [leasedJob] });
    await processor.processBatch(1);
    const ownership = queries.find(({ sql }) =>
      sql.startsWith('SELECT j.id FROM project_knowledge.outbox_jobs j'),
    )!;
    expect(ownership?.sql).toContain('FOR UPDATE OF j');
    expect(ownership?.sql).toContain('j.attempts=claim.attempt');
    const apply = queries.find(({ sql }) => sql.includes('WITH vector_data'))!;
    expect(apply.sql).toContain('c.content_hash=claimed.content_hash');
    expect(apply.sql).toContain('WHERE c.id=target.id AND c.embedding IS NULL');
    expect(apply.sql).toContain('j.id=ANY($9::uuid[])');
  });

  it('uses a cache hit without calling the embedder', async () => {
    const { processor, embedder } = harness({
      jobs: [
        {
          id: 'job-1',
          chunk_id: 'chunk-1',
          project_id: 'project-1',
          content: 'same',
          content_hash: 'content-a',
          embed_hash: 'hash-a',
        },
      ],
      cached: [{ text_hash: 'hash-a', embedding: '[0.1,0.2,0.3]' }],
      applied: 1,
    });

    await expect(processor.processBatch(50)).resolves.toMatchObject({
      embedded: 0,
      cacheHits: 1,
      applied: 1,
    });
    expect(embedder.embedMany).not.toHaveBeenCalled();
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it('deduplicates misses by cache key, stores vectors, and applies them with one unnest statement', async () => {
    const { processor, embedder, queries } = harness({
      jobs: [
        {
          id: 'job-1',
          chunk_id: 'chunk-1',
          project_id: 'project-1',
          content: 'same',
          content_hash: 'content-a',
          embed_hash: 'hash-a',
        },
        {
          id: 'job-2',
          chunk_id: 'chunk-2',
          project_id: 'project-2',
          content: 'same',
          content_hash: 'content-b',
          embed_hash: 'hash-a',
        },
      ],
      applied: 2,
    });

    await expect(processor.processBatch(50)).resolves.toMatchObject({
      claimed: 2,
      embedded: 1,
      applied: 2,
    });
    expect(embedder.embedMany).toHaveBeenCalledWith(['same']);
    expect(
      queries.some(({ sql }) =>
        sql.includes('INSERT INTO project_knowledge.embedding_compute_leases'),
      ),
    ).toBe(true);
    expect(
      queries.filter(({ sql }) =>
        sql.includes('INSERT INTO project_knowledge.embedding_cache'),
      ),
    ).toHaveLength(1);
    expect(
      queries.filter(({ sql }) => sql.includes('WITH vector_data')),
    ).toHaveLength(1);
    const targetProjects = queries.find(({ sql }) =>
      sql.includes('SELECT DISTINCT project_id FROM ('),
    )!;
    expect(targetProjects.sql).toContain('UNION');
    expect(targetProjects.sql).not.toContain(
      'c.embed_hash::text=ANY($1::text[]) OR',
    );
    const apply = queries.find(({ sql }) => sql.includes('WITH vector_data'))!;
    expect(apply.sql).toContain('UNION');
    expect(apply.sql).toContain(
      'embed_hash=COALESCE(c.embed_hash,target.text_hash)',
    );
    expect(apply.sql).not.toContain(
      'JOIN vector_data data ON c.embed_hash::text=data.text_hash OR',
    );
  });

  it('normalizes and caps legacy chunk content before embedding it', async () => {
    const content = `${'word '.repeat(400)}\r\ntrailing   `;
    const { processor, embedder } = harness({
      jobs: [
        {
          id: 'job-1',
          chunk_id: 'chunk-1',
          project_id: 'project-1',
          content,
          content_hash: 'legacy-content-hash',
          embed_hash: null,
        },
      ],
    });

    await processor.processBatch(10);

    const embeddedText = embedder.embedMany.mock.calls[0]![0][0]!;
    expect(embeddedText.length).toBeLessThanOrEqual(1500);
    expect(embeddedText).not.toContain('\r');
    expect(embeddedText).not.toMatch(/[ \t]+$/mu);
  });

  it('sweeps stuck and inactive jobs and claims by priority', async () => {
    const { processor, queries } = harness({
      sweep: {
        completed: 2,
        retired_inactive: 3,
      },
    });

    await expect(processor.processBatch(10)).resolves.toMatchObject({
      completed: 2,
      retired: 3,
    });
    const sweep = queries.find(({ sql }) =>
      sql.includes('AS retired_superseded'),
    )!;
    expect(sweep.sql).toContain(
      "resolution=jsonb_build_object('reason','already_embedded')",
    );
    expect(sweep.sql).toContain(
      "resolution=jsonb_build_object('reason','inactive_chunk')",
    );
    const claim = queries.find(({ sql }) => sql.includes('WITH fair'))!;
    expect(claim.sql).toContain('c.active');
    expect(claim.sql).toContain(
      'ORDER BY fair.project_rank, fair.priority DESC, fair.created_at',
    );
    expect(claim.sql).not.toContain('project_rank=1');
    expect(claim.sql).toContain("j.required_capability='embedding'");
    expect(claim.sql).toContain('j.attempts<j.max_attempts');
    expect(claim.sql).toContain("lease_expires_at=now()+interval '2 minutes'");
    expect(claim.sql).toContain('chunks.embed_hash');
  });

  it('repairs orphans on the first batch and skips repair within the interval', async () => {
    let now = 1_000;
    const { processor, queries } = harness({
      reenqueued: 4,
      orphanRepairIntervalMs: 600_000,
      now: () => now,
    });

    await expect(processor.processBatch(10)).resolves.toMatchObject({
      reenqueued: 4,
    });
    now += 1_000;
    await expect(processor.processBatch(10)).resolves.toMatchObject({
      reenqueued: 0,
    });

    const repairs = queries.filter(({ sql }) => sql.includes('AS reenqueued'));
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.sql).toContain("c.kind<>'symbol'");
    expect(repairs[0]!.sql).toContain("existing.job_key='embed:'||c.id::text");
    expect(repairs[0]!.values).toContainEqual([
      'documentation',
      'api_endpoint',
      'database_table',
      'file_summary',
    ]);
  });

  it('uses bounded exponential backoff when a model batch fails', async () => {
    const { processor, queries } = harness({
      jobs: [
        {
          id: 'job-1',
          chunk_id: 'chunk-1',
          project_id: 'project-1',
          content: 'content',
          content_hash: 'hash-a',
          embed_hash: 'hash-a',
        },
      ],
      embedMany: async () => {
        throw new Error('offline');
      },
    });

    await expect(processor.processBatch(10)).resolves.toMatchObject({
      failed: 1,
    });
    expect(queries.some(({ sql }) => sql.includes('power(2'))).toBe(true);
  });
});
