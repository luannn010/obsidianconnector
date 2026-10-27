import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import {
  artifactFileName,
  assertBranchName,
  assertCardSlug,
  isCardStatus,
  renderCardNote,
  slugify,
  uniqueSlug,
  upsertArtifact,
} from '../../src/ideas/idea-cards.js';
import { IdeaError } from '../../src/ideas/errors.js';

describe('idea cards', () => {
  it('normalizes titles into bounded, non-empty slugs', () => {
    expect(slugify('')).toBe('idea');
    expect(slugify('  Hello, WORLD!  ')).toBe('hello-world');
    const long = slugify(`${'a'.repeat(59)} -- trailing words`);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).not.toMatch(/-$/u);
  });

  it('adds the first available numeric suffix to a taken slug', () => {
    expect(uniqueSlug('Same idea', new Set())).toBe('same-idea');
    expect(uniqueSlug('Same idea', new Set(['same-idea', 'same-idea-2']))).toBe(
      'same-idea-3',
    );
  });

  it.each(['../x', 'A', ''])('rejects unsafe card slug %j', (slug) => {
    expect(() => assertCardSlug(slug)).toThrow(IdeaError);
  });

  it.each(['feature/../main', '-leading'])(
    'rejects unsafe spike branch %j',
    (branch) => {
      expect(() => assertBranchName(branch)).toThrow(IdeaError);
    },
  );

  it('chooses the expected artifact filenames and diagram extensions', () => {
    expect(artifactFileName('plan', 'Ignored')).toBe('plan.md');
    expect(artifactFileName('html', 'Clickable Demo')).toBe(
      'prototypes/clickable-demo.html',
    );
    expect(artifactFileName('diagram', 'System Map')).toBe(
      'prototypes/system-map.mmd',
    );
    expect(artifactFileName('diagram', 'System Map', 'svg')).toBe(
      'prototypes/system-map.svg',
    );
  });

  it('renders default frontmatter, deduplicated prototypes, and acceptance checkboxes', () => {
    const rendered = renderCardNote(
      'lunar',
      'idea-1234',
      {
        title: 'Launch panel',
        problem: '  Hard to launch.  ',
        proposal: '  Add a panel.  ',
        acceptance: [' Opens quickly ', 'Works offline'],
        prototypes: ['html', 'diagram', 'html'],
      },
      '2026-10-27T00:00:00.000Z',
    );
    const parsed = matter(rendered.markdown);

    expect(rendered.frontmatter).toMatchObject({
      kind: 'work_item',
      card: true,
      project_key: 'lunar',
      status: 'backlog',
      priority: 'medium',
      prototypes_requested: ['html', 'diagram'],
      artifacts: [],
      spike_branch: null,
      review_note: null,
      knowledge_id: null,
    });
    expect(parsed.data).toMatchObject(rendered.frontmatter);
    expect(parsed.content).toContain('- [ ] Opens quickly');
    expect(parsed.content).toContain('- [ ] Works offline');
  });

  it('replaces an artifact at the same path without disturbing others', () => {
    const result = upsertArtifact(
      [
        { type: 'plan', title: 'Old plan', path: 'plan.md' },
        { type: 'spike', title: 'Spike', branch: 'feature/test' },
      ],
      { type: 'plan', title: 'New plan', path: 'plan.md' },
    );

    expect(result).toEqual([
      { type: 'spike', title: 'Spike', branch: 'feature/test' },
      { type: 'plan', title: 'New plan', path: 'plan.md' },
    ]);
  });

  it('recognizes only supported card statuses', () => {
    expect(isCardStatus('ready')).toBe(true);
    expect(isCardStatus('unknown')).toBe(false);
    expect(isCardStatus(null)).toBe(false);
  });
});
