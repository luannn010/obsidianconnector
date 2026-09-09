import { describe, expect, it } from 'vitest';
import { packWithinTokenBudget } from '../../src/knowledge/token-budget.js';

describe('token budget packing', () => {
  it('counts the complete serialized envelope and reports omissions', () => {
    const result = packWithinTokenBudget(
      [
        { ref: 'one', title: 'One', excerpt: 'short' },
        { ref: 'two', title: 'Two', excerpt: 'x '.repeat(200) },
      ],
      100,
      { freshness: 'current' },
    );

    expect(result.results.map((item) => item.ref)).toEqual(['one']);
    expect(result.budget.used).toBeLessThanOrEqual(100);
    expect(result.budget.omitted).toBe(1);
    expect(result.budget.truncated).toBe(true);
    expect(result.budget.continuation).toBeTruthy();
  });
});
