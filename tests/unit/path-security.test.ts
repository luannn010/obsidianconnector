import { mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SecurityError,
  resolveVaultPath,
} from '../../src/security/path-security.js';

const roots: string[] = [];

async function makeVault(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-security-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('vault path security', () => {
  it('resolves a safe relative Markdown note inside the vault', async () => {
    const root = await makeVault();
    const resolved = await resolveVaultPath(root, 'Projects/plan.md', {
      kind: 'note',
      allowMissing: true,
    });
    expect(resolved).toBe(path.join(root, 'Projects', 'plan.md'));
  });

  it.each([
    'C:\\outside.md',
    '/outside.md',
    '\\outside.md',
    '../outside.md',
    'folder/../../outside.md',
    'folder\\..\\outside.md',
  ])('rejects unsafe path %s', async (notePath) => {
    const root = await makeVault();
    await expect(
      resolveVaultPath(root, notePath, { kind: 'note', allowMissing: true }),
    ).rejects.toBeInstanceOf(SecurityError);
  });

  it('rejects null bytes, excluded directories, hidden directories, and non-Markdown notes', async () => {
    const root = await makeVault();
    await expect(
      resolveVaultPath(root, 'safe\0.md', { kind: 'note', allowMissing: true }),
    ).rejects.toMatchObject({ code: 'NULL_BYTE' });
    await expect(
      resolveVaultPath(root, '.obsidian/app.json', {
        kind: 'directory',
        allowMissing: true,
      }),
    ).rejects.toMatchObject({ code: 'EXCLUDED_PATH' });
    await expect(
      resolveVaultPath(root, '.hidden/note.md', {
        kind: 'note',
        allowMissing: true,
      }),
    ).rejects.toMatchObject({ code: 'EXCLUDED_PATH' });
    await expect(
      resolveVaultPath(root, 'notes.txt', { kind: 'note', allowMissing: true }),
    ).rejects.toMatchObject({ code: 'MARKDOWN_REQUIRED' });
  });

  it('rejects a symlink that escapes the registered vault', async () => {
    const root = await makeVault();
    const outside = await mkdtemp(
      path.join(os.tmpdir(), 'obsidian-mcp-outside-'),
    );
    roots.push(outside);
    await writeFile(path.join(outside, 'secret.md'), 'secret');
    const link = path.join(root, 'linked');
    try {
      await symlink(outside, link, 'junction');
    } catch (error) {
      throw new Error(
        `Symlink escape test could not create a junction: ${String(error)}`,
      );
    }
    await expect(
      resolveVaultPath(root, 'linked/secret.md', { kind: 'note' }),
    ).rejects.toMatchObject({ code: 'OUTSIDE_VAULT' });
  });

  it('rejects an existing path when allowMissing is false', async () => {
    const root = await makeVault();
    await mkdir(path.join(root, 'notes'));
    await expect(
      resolveVaultPath(root, 'notes/missing.md', {
        kind: 'note',
        allowMissing: false,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
