import { describe, expect, it } from 'vitest';
import { KnowledgeError } from '../../src/knowledge/errors.js';
import { toolFailure } from '../../src/tools/tool-utils.js';

describe('knowledge errors', () => {
  it('returns a typed safe error envelope', () => {
    const result = toolFailure(
      new KnowledgeError('VERSION_CONFLICT', 'Item changed', false, {
        itemId: 'safe-id',
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: 'VERSION_CONFLICT',
        message: 'Item changed',
        retryable: false,
        details: { itemId: 'safe-id' },
      },
    });
  });
});
