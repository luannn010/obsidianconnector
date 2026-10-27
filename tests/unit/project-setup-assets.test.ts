import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

describe('project setup command surfaces', () => {
  it('provides PowerShell WhatIf, wait, and secure connection prompting', async () => {
    const script = await readFile(
      path.join(root, 'scripts', 'setup-project.ps1'),
      'utf8',
    );
    expect(script).toContain('SupportsShouldProcess = $true');
    expect(script).toContain('[switch]$Wait');
    expect(script).toContain('Read-Host -AsSecureString');
    expect(script).toContain('PROJECT_KNOWLEDGE_SOURCE_WORKTREE_ID');
  });

  it('provides a slash command that delegates to the canonical skill', async () => {
    const command = await readFile(
      path.join(root, 'commands', 'project-setup.md'),
      'utf8',
    );
    const skill = await readFile(
      path.join(root, '.codex', 'skills', 'project-setup', 'SKILL.md'),
      'utf8',
    );
    expect(command).toContain('.codex/skills/project-setup/SKILL.md');
    expect(skill).toContain('Ask for the Obsidian vault path first');
    expect(skill).toContain('scripts/setup-project.ps1');
  });
});
