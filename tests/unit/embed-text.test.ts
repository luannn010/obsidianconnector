import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EMBEDDABLE_CHUNK_KINDS,
  EMBEDDING_TEXT_LIMIT,
  embeddingHash,
  embeddingModelKey,
  embeddingText,
  normalizeEmbeddingText,
  queryEmbeddingText,
} from '../../src/knowledge/embed-text.js';

describe('embedding text', () => {
  it('normalizes line endings, trailing whitespace, and excess blank lines', () => {
    expect(normalizeEmbeddingText('  first  \r\n\r\n\r\nsecond\t \r')).toBe(
      'first\n\nsecond',
    );
  });

  it('caps text at a natural boundary when one exists', () => {
    const prefix = 'a'.repeat(EMBEDDING_TEXT_LIMIT - 5);
    const result = embeddingText(`${prefix} stopping overflow`);

    expect(result).toBe(prefix);
    expect(result).toHaveLength(EMBEDDING_TEXT_LIMIT - 5);
  });

  it('hard-caps text when no natural boundary exists', () => {
    expect(embeddingText('x'.repeat(EMBEDDING_TEXT_LIMIT + 10))).toBe(
      'x'.repeat(EMBEDDING_TEXT_LIMIT),
    );
  });

  it('hashes the exact normalized embedding text', () => {
    expect(embeddingHash('hello\r\n')).toBe(
      createHash('sha256').update('hello', 'utf8').digest('hex'),
    );
  });

  it('builds model keys and query instructions', () => {
    expect(
      embeddingModelKey({
        name: 'BAAI/bge-small-en-v1.5',
        revision: 'r1',
        dimensions: 384,
      }),
    ).toBe('BAAI/bge-small-en-v1.5@r1:384');
    expect(queryEmbeddingText(' find this  \r\n')).toBe(
      'Represent this sentence for searching relevant passages: find this',
    );
    expect(EMBEDDABLE_CHUNK_KINDS).toEqual([
      'documentation',
      'api_endpoint',
      'database_table',
      'file_summary',
    ]);
  });
});
