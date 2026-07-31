import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('README documentation', () => {
  it('documents setup, clients, troubleshooting, and every MCP tool', async () => {
    const readme = await readFile(
      new URL('../../README.md', import.meta.url),
      'utf8',
    );
    for (const phrase of [
      'Windows PowerShell',
      'WSL/Linux',
      'ChatGPT Desktop',
      'Codex CLI',
      'Codex IDE',
      'Troubleshooting',
      'codex mcp add obsidian-local -- node ABSOLUTE_PATH_TO_PROJECT/dist/index.js',
      'list_vaults',
      'get_vault',
      'create_vault',
      'register_vault',
      'unregister_vault',
      'list_directory',
      'create_directory',
      'list_notes',
      'search_notes',
      'read_note',
      'create_note',
      'update_note',
      'append_note',
      'move_note',
      'delete_note',
      'get_frontmatter',
      'update_frontmatter',
      'list_tags',
      'list_backlinks',
      'append_daily_note',
      'get_project_context',
      'get_project_activity',
    ]) {
      expect(readme).toContain(phrase);
    }
  });
});
