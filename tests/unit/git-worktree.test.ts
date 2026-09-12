import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  fingerprintWorktree,
  parseGitNameStatus,
  parseWorktreeList,
  shouldIndexPath,
} from '../../src/worker/git-worktree.js';

const execFileAsync = promisify(execFile);

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

  it('changes the dirty fingerprint when an already-modified file changes again', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dirty-fingerprint-'));
    await execFileAsync('git', ['init', root]);
    await execFileAsync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Test']);
    await writeFile(path.join(root, 'module.ts'), 'export const value = 1;\n');
    await execFileAsync('git', ['-C', root, 'add', 'module.ts']);
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'initial']);

    await writeFile(path.join(root, 'module.ts'), 'export const value = 2;\n');
    const first = await fingerprintWorktree(root);
    await writeFile(path.join(root, 'module.ts'), 'export const value = 3;\n');
    const second = await fingerprintWorktree(root);

    expect(first.status).toBe(second.status);
    expect(first.dirtyHash).not.toBe(second.dirtyHash);
  });
});
