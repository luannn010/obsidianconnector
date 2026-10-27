import { describe, expect, it } from 'vitest';
import {
  STATUSES,
  cardPrototypes,
  cardSlugFromPath,
  groupByStatus,
  isSafeRelativePath,
  normalizeStatus,
  parseCard,
  parseProjectInfo,
  planPath,
} from '../src/model';

const frontmatter = {
  kind: 'work_item',
  card: true,
  project_key: 'lunar',
  title: 'Dark mode',
  status: 'plan-review',
  priority: 'high',
  idea_ref: 'Ideas.md#dark-mode',
  prototypes_requested: ['html', 'diagram', 'bogus'],
  artifacts: [
    { type: 'plan', title: 'Plan', path: 'plan.md' },
    { type: 'html', title: 'Toggle', path: 'prototypes/toggle.html' },
    { type: 'diagram', title: 'Flow', path: 'prototypes/flow.mmd' },
    { type: 'spike', title: 'Spike', branch: 'spike/dark-mode' },
    { type: 'html', title: 'Escape', path: '../../secret.html' },
  ],
  spike_branch: 'spike/dark-mode',
  review_note: '',
};

describe('status columns', () => {
  it('has the seven board columns in flow order', () => {
    expect(STATUSES).toEqual([
      'backlog',
      'planning',
      'plan-review',
      'ready',
      'building',
      'review',
      'done',
    ]);
  });

  it('normalizes loose status values and defaults to backlog', () => {
    expect(normalizeStatus('Plan Review')).toBe('plan-review');
    expect(normalizeStatus('plan_review')).toBe('plan-review');
    expect(normalizeStatus('nope')).toBe('backlog');
    expect(normalizeStatus(undefined)).toBe('backlog');
  });

  it('groups cards by status and sorts by priority', () => {
    const a = parseCard('Board/Cards/a/card.md', {
      ...frontmatter,
      title: 'A',
      priority: 'low',
      status: 'ready',
    })!;
    const b = parseCard('Board/Cards/b/card.md', {
      ...frontmatter,
      title: 'B',
      priority: 'p0',
      status: 'ready',
    })!;
    const c = parseCard('Board/Cards/c/card.md', {
      ...frontmatter,
      title: 'C',
      status: 'done',
    })!;
    const columns = groupByStatus([a, b, c]);
    expect(columns.ready.map((card) => card.title)).toEqual(['B', 'A']);
    expect(columns.done).toHaveLength(1);
    expect(columns.backlog).toHaveLength(0);
  });
});

describe('card parsing', () => {
  it('only accepts card.md directly under Board/Cards/<slug>/', () => {
    expect(cardSlugFromPath('Board/Cards/dark-mode/card.md')).toBe('dark-mode');
    expect(cardSlugFromPath('Board/Cards/dark-mode/plan.md')).toBeNull();
    expect(cardSlugFromPath('Board/Cards/a/b/card.md')).toBeNull();
    expect(cardSlugFromPath('Other/Cards/a/card.md')).toBeNull();
  });

  it('requires card: true', () => {
    expect(
      parseCard('Board/Cards/x/card.md', { ...frontmatter, card: false }),
    ).toBeNull();
    expect(parseCard('Board/Cards/x/card.md', undefined)).toBeNull();
  });

  it('parses fields, filters prototype types, and drops unsafe artifact paths', () => {
    const card = parseCard('Board/Cards/dark-mode/card.md', frontmatter)!;
    expect(card).toMatchObject({
      slug: 'dark-mode',
      folder: 'Board/Cards/dark-mode',
      projectKey: 'lunar',
      title: 'Dark mode',
      status: 'plan-review',
      prototypesRequested: ['html', 'diagram'],
      spikeBranch: 'spike/dark-mode',
    });
    expect(card.artifacts.map((artifact) => artifact.title)).toEqual([
      'Plan',
      'Toggle',
      'Flow',
      'Spike',
    ]);
    expect(planPath(card)).toBe('Board/Cards/dark-mode/plan.md');
  });

  it('lists prototypes with kinds and vault paths, without duplicating the spike', () => {
    const card = parseCard('Board/Cards/dark-mode/card.md', frontmatter)!;
    expect(cardPrototypes(card)).toEqual([
      {
        title: 'Toggle',
        kind: 'html',
        vaultPath: 'Board/Cards/dark-mode/prototypes/toggle.html',
      },
      {
        title: 'Flow',
        kind: 'mermaid',
        vaultPath: 'Board/Cards/dark-mode/prototypes/flow.mmd',
      },
      { title: 'Spike', kind: 'spike', branch: 'spike/dark-mode' },
    ]);
  });

  it('falls back to the slug as title and handles missing lists', () => {
    const card = parseCard('Board/Cards/bare/card.md', { card: true })!;
    expect(card.title).toBe('bare');
    expect(card.status).toBe('backlog');
    expect(card.artifacts).toEqual([]);
    expect(cardPrototypes(card)).toEqual([]);
  });

  it('rejects absolute and parent-relative paths', () => {
    expect(isSafeRelativePath('prototypes/a.html')).toBe(true);
    expect(isSafeRelativePath('../a.html')).toBe(false);
    expect(isSafeRelativePath('/a.html')).toBe(false);
    expect(isSafeRelativePath('C:\\a.html')).toBe(false);
  });
});

describe('project info', () => {
  it('parses Board/.project.json', () => {
    expect(
      parseProjectInfo(
        '{"projectKey":"lunar","repoPath":"C:\\\\Repos\\\\Lunar"}',
      ),
    ).toEqual({
      projectKey: 'lunar',
      repoPath: 'C:\\Repos\\Lunar',
    });
    expect(parseProjectInfo('not json')).toBeNull();
    expect(parseProjectInfo('{}')).toBeNull();
  });
});
