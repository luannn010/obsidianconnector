import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { EmbeddingQueueProcessor } from '../../src/worker/embedding-queue-processor.js';

describe('EmbeddingQueueProcessor', () => {
  it('embeds one representative and fans the vector out to matching current chunks', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes('AS retired_superseded'))
          return { rows: [{ retired_superseded: 2, retired_missing: 1, completed: 1, reused: 3 }] };
        if (sql.includes('RETURNING jobs.id'))
          return {
            rows: [
              { id: 'job-1', chunk_id: 'chunk-1', project_id: 'project-1', content: 'same', content_hash: 'hash-a' },
              { id: 'job-2', chunk_id: 'chunk-2', project_id: 'project-1', content: 'same', content_hash: 'hash-a' },
              { id: 'job-3', chunk_id: 'chunk-3', project_id: 'project-1', content: 'different', content_hash: 'hash-b' },
            ],
          };
        if (sql.includes('INSERT INTO project_knowledge.embedding_models'))
          return { rows: [{ id: 'model-1' }] };
        if (sql.includes('AS applied')) return { rows: [{ applied: 2 }] };
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const embedder = {
      embed: vi.fn(async () => [0, 0, 0]),
      embedMany: vi.fn(async () => [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]),
    };
    const processor = new EmbeddingQueueProcessor(
      { connect: async () => client } as unknown as Pool,
      embedder,
      { name: 'test-model', revision: 'r1', dimensions: 3 },
    );

    await expect(processor.processBatch(50)).resolves.toMatchObject({
      embedded: 2,
      applied: 4,
      reused: 3,
      retired: 3,
    });
    expect(embedder.embedMany).toHaveBeenCalledWith(['same', 'different']);
    expect(queries.some(({ sql }) => sql.includes('SKIP LOCKED'))).toBe(true);
    expect(queries.filter(({ sql }) => sql.includes('AS applied'))).toHaveLength(2);
  });

  it('uses bounded exponential backoff when a model batch fails', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes('AS retired_superseded')) return { rows: [{}] };
        if (sql.includes('RETURNING jobs.id'))
          return { rows: [{ id: 'job-1', chunk_id: 'chunk-1', project_id: 'project-1', content: 'content', content_hash: 'hash-a' }] };
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const processor = new EmbeddingQueueProcessor(
      { connect: async () => client } as unknown as Pool,
      { embed: vi.fn(async () => { throw new Error('offline'); }) },
      { name: 'test-model', revision: 'r1', dimensions: 3 },
    );

    await expect(processor.processBatch(10)).resolves.toMatchObject({ failed: 1 });
    expect(queries.some(({ sql }) => sql.includes('power(2'))).toBe(true);
  });
});
