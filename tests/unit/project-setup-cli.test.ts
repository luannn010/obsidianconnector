import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  defaultSetupIdentity,
  parseSetupArguments,
  redactDatabaseUrl,
} from '../../src/setup-project.js';

describe('project setup CLI', () => {
  it('derives the project key and name from the vault directory', () => {
    expect(defaultSetupIdentity('G:\\My Drive\\.obsidian\\Host-Mesh')).toEqual({
      projectKey: 'Host-Mesh',
      name: 'Host-Mesh',
      vaultName: 'Host-Mesh',
    });
  });

  it('parses apply and WhatIf arguments without accepting unknown flags', () => {
    expect(
      parseSetupArguments([
        '--project-path',
        'D:\\Host-Mesh',
        '--vault-path',
        'G:\\My Drive\\.obsidian\\Host-Mesh',
        '--projects-root',
        'D:\\',
        '--vault-root',
        'G:\\My Drive\\.obsidian',
        '--what-if',
      ]),
    ).toMatchObject({ whatIf: true, projectPath: 'D:\\Host-Mesh' });
    expect(() => parseSetupArguments(['--unknown'])).toThrow(
      'Unknown argument',
    );
  });

  it('redacts passwords from database URLs', () => {
    expect(
      redactDatabaseUrl('postgresql://worker:secret@db.internal:5432/playnode'),
    ).toBe('postgresql://worker:***@db.internal:5432/playnode');
  });

  it('runs a mutation-free JSON WhatIf from the command line', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'project-setup-cli-'));
    const project = path.join(root, 'Host-Mesh');
    const vaultRoot = path.join(root, 'vaults');
    const vault = path.join(vaultRoot, 'Host-Mesh');
    await mkdir(project);
    await mkdir(vaultRoot);
    try {
      const result = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          path.join(
            path.resolve(import.meta.dirname, '../..'),
            'src',
            'setup-project.ts',
          ),
          '--project-path',
          project,
          '--vault-path',
          vault,
          '--projects-root',
          root,
          '--vault-root',
          vaultRoot,
          '--what-if',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PROJECT_KNOWLEDGE_DATABASE_URL: '',
            PROJECT_KNOWLEDGE_MIGRATION_DATABASE_URL: '',
          },
        },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: 'what-if',
        projectKey: 'Host-Mesh',
        database: { configured: false, connected: false },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
