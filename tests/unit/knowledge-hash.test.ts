import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  normalizeManagedMarkdown,
  projectionHash,
} from '../../src/knowledge/hash.js';

describe('knowledge hashes', () => {
  it('hashes equivalent objects identically regardless of key order', () => {
    expect(canonicalHash({ b: 2, a: { y: true, x: 'one' } })).toBe(
      canonicalHash({ a: { x: 'one', y: true }, b: 2 }),
    );
  });

  it('normalizes line endings and excludes volatile managed frontmatter', () => {
    const first = `---\r\nview_id: api-index\r\ngenerated_at: 2026-09-05T00:00:00Z\r\nprojection_hash: old\r\nmanaged: true\r\n---\r\n# API\r\nBody\r\n`;
    const second = `---\nmanaged: true\nprojection_hash: new\ngenerated_at: 2026-09-06T00:00:00Z\nview_id: api-index\n---\n# API\nBody\n`;

    expect(normalizeManagedMarkdown(first)).toBe(
      normalizeManagedMarkdown(second),
    );
    expect(projectionHash(first)).toBe(projectionHash(second));
  });
});
