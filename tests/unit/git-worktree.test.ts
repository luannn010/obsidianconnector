import { describe, expect, it } from 'vitest';
import {
  parseGitNameStatus,
  parseWorktreeList,
  shouldIndexPath,
} from '../../src/worker/git-worktree.js';

describe('Git worktree reconciliation', () => {
  it('parses changed, deleted, and renamed paths without mixing worktrees', () => {
    expect(
      parseGitNameStatus('M\tsrc/a.ts\nD\tsrc/b.ts\nR100\told.ts\tnew.ts\n'),
    ).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'D', path: 'src/b.ts' },
      { status: 'R', path: 'new.ts', previousPath: 'old.ts' },
    ]);
  });
  it('parses registered Git worktrees from porcelain output', () => {
    expect(
      parseWorktreeList(
        'worktree C:/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/repo/.worktrees/a\nHEAD def\nbranch refs/heads/feature/a\n',
      ),
    ).toEqual([
      { path: 'C:/repo', head: 'abc', branch: 'main' },
      { path: 'C:/repo/.worktrees/a', head: 'def', branch: 'feature/a' },
    ]);
  });
  it('allowlists useful text and excludes secrets and generated directories', () => {
    expect(shouldIndexPath('packages/admin/src/server.ts')).toBe(true);
    expect(shouldIndexPath('db/01_authentication.sql')).toBe(true);
    expect(shouldIndexPath('.env')).toBe(false);
    expect(shouldIndexPath('node_modules/pkg/index.js')).toBe(false);
    expect(shouldIndexPath('dist/output.js')).toBe(false);
  });
});
