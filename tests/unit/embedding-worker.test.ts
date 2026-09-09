import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { KnowledgeWorker } from '../../src/worker/knowledge-worker.js';

describe('knowledge worker embedding batches', () => {
  it('embeds a claimed job batch in one model request', async () => {
    const jobs = [
      { id: 'job-1', payload: { chunkId: 'chunk-1' } },
      { id: 'job-2', payload: { chunkId: 'chunk-2' } },
    ];
    const completed: string[] = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes("SET state='processing'")) return { rows: jobs };
        if (sql.includes('SELECT content,project_id')) {
          const chunkId = String(values?.[0]);
          return {
            rows: [{ content: `content for ${chunkId}`, project_id: 'project-1' }],
          };
        }
        if (sql.includes('INSERT INTO project_knowledge.embedding_models')) {
          return { rows: [{ id: 'model-1' }] };
        }
        if (sql.includes("SET state='done'")) {
          completed.push(String(values?.[0]));
        }
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
    const pool = {
      connect: async () => client,
    } as unknown as Pool;
    const worker = new KnowledgeWorker(pool, embedder, {
      name: 'test-model',
      revision: 'test',
      dimensions: 3,
    });

    await expect(worker.processEmbeddings(50)).resolves.toBe(2);
    expect(embedder.embedMany).toHaveBeenCalledWith([
      'content for chunk-1',
      'content for chunk-2',
    ]);
    expect(embedder.embed).not.toHaveBeenCalled();
    expect(completed).toEqual(['job-1', 'job-2']);
  });
});
