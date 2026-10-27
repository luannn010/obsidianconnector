import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const canonical = path.join(root, '.codex/skills/project-to-obsidian');
const mirror = path.join(root, '.claude/skills/project-to-obsidian');

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(directory, prefix), {
    withFileTypes: true,
  });
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? listFiles(directory, path.join(prefix, entry.name))
        : [path.join(prefix, entry.name).replace(/\\/gu, '/')],
    ),
  );
  return files.flat().sort();
}

async function text(file: string): Promise<string> {
  return (await readFile(file, 'utf8')).replace(/\r\n/gu, '\n');
}

describe('shared agent instructions', () => {
  it('keeps the Claude skill mirror identical to the canonical Codex skill', async () => {
    const files = await listFiles(canonical);
    expect(files).toContain('SKILL.md');
    expect(await listFiles(mirror)).toEqual(files);
    for (const file of files)
      expect(await text(path.join(mirror, file)), file).toBe(
        await text(path.join(canonical, file)),
      );
  });

  it('points both agents at the same project knowledge workflow', async () => {
    const agents = await text(path.join(root, 'AGENTS.md'));
    expect(agents).toContain('.codex/skills/project-to-obsidian/SKILL.md');
    expect(agents).toContain('recall_project_knowledge');
    expect(agents).toContain('Cross-agent handoff');
    const claude = await text(path.join(root, 'CLAUDE.md'));
    expect(claude.split('\n')[0]).toBe('@AGENTS.md');
  });
});
