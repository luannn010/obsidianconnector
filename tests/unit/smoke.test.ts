import { describe, expect, it } from 'vitest';
import { projectVersion } from '../../src/types/index.js';

describe('project bootstrap', () => {
  it('exports a string project version', () => {
    expect(typeof projectVersion).toBe('string');
  });
});
