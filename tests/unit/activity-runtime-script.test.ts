import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('activity runtime installer', () => {
  it('protects the local token file and installs project-scoped hooks', async () => {
    const script = await readFile(
      'scripts/install-activity-runtime.ps1',
      'utf8',
    );
    expect(script).toContain("'/inheritance:r'");
    expect(script).toContain("'/grant:r'");
    expect(script).toContain("Join-Path $ProjectPath '.codex\\hooks.json'");
    expect(script).toContain(
      "Join-Path $ProjectPath '.claude\\settings.local.json'",
    );
    expect(script).toContain("shell = 'powershell'");
    expect(script).toContain("$claudeHookBase = '& ");
    expect(script).toContain("Join-Path $ProjectPath '.mcp.json'");
    expect(script).toContain("Join-Path $HOME '.claude\\skills'");
    expect(script).toContain("OBSIDIAN_MCP_PROFILE = 'standard'");
    expect(script).not.toContain("Join-Path $HOME '.codex\\hooks.json'");
  });

  it('loads the shared project-knowledge environment in the worker entrypoint', async () => {
    const worker = await readFile('src/worker.ts', 'utf8');

    expect(worker).toContain('loadProjectKnowledgeEnvironment(projectRoot)');
    expect(worker).not.toContain('loadDotEnv();');
  });
});
