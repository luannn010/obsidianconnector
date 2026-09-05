import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRegistry } from '../../src/config/registry.js';
import { FilesystemService } from '../../src/services/filesystem-service.js';
import { ProjectContextService } from '../../src/services/project-context-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeService(): Promise<{
  root: string;
  service: ProjectContextService;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-context-'));
  roots.push(root);
  const registry = await VaultRegistry.load(path.join(root, 'config.json'));
  await registry.register('testing', root);
  return {
    root,
    service: new ProjectContextService(
      registry,
      new FilesystemService(registry),
    ),
  };
}

async function makeIndexedService(): Promise<{
  root: string;
  service: ProjectContextService;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-index-'));
  roots.push(root);
  const registry = await VaultRegistry.load(path.join(root, 'config.json'));
  await registry.register('indexed', root);
  return {
    root,
    service: new ProjectContextService(
      registry,
      new FilesystemService(registry),
    ),
  };
}

async function makeRoleMappedService(): Promise<{
  root: string;
  service: ProjectContextService;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-roles-'));
  roots.push(root);
  const registry = await VaultRegistry.load(path.join(root, 'config.json'));
  await registry.register('mapped', root, false, undefined, {
    roles: {
      tasks: '04 - Plans & Specs/Tasks.md',
      decisions: '04 - Plans & Specs/Decisions.md',
      risks: '01 - Business Plan/Risks.md',
      changelog: '06 - Repository Reference/Changelog.md',
    },
  });
  return {
    root,
    service: new ProjectContextService(
      registry,
      new FilesystemService(registry),
    ),
  };
}

describe('project context service', () => {
  it('uses configured role paths before legacy defaults for context verification', async () => {
    const { root, service } = await makeRoleMappedService();
    await mkdir(path.join(root, '04 - Plans & Specs'), { recursive: true });
    await writeFile(
      path.join(root, '04 - Plans & Specs', 'Tasks.md'),
      '---\nlast_verified: "2999-01-01"\nrelated_paths: [src/tasks.ts]\n---\n- [ ] Ship mapped tasks\n',
    );

    const context = await service.getContext('mapped', 5000);

    expect(context.indexManifest.tasks).toBe('04 - Plans & Specs/Tasks.md');
    expect(context.notes.find((note) => note.role === 'tasks')).toMatchObject({
      exists: true,
      path: '04 - Plans & Specs/Tasks.md',
      content: expect.stringContaining('Ship mapped tasks'),
      verification: { stale: false, gaps: [] },
    });
    expect(context.verificationGaps).not.toContainEqual(
      expect.objectContaining({
        role: 'tasks',
        path: '06 - Tasks.md',
        reason: 'missing_note',
      }),
    );
  });

  it('reads a manifest and reports codebase note metadata and verification gaps', async () => {
    const { root, service } = await makeIndexedService();
    await writeFile(
      path.join(root, 'Codebase Index.md'),
      '---\nroles:\n  repository_map: Repository Map.md\n  ownership: Ownership.md\n---\n# Index\n',
    );
    await writeFile(
      path.join(root, 'Repository Map.md'),
      '---\nstatus: verified\nlast_verified: 2026-08-01\nrepository_revision: abc123\nowners: [platform]\nrelated_paths: [src/server.ts, tests/integration/server.integration.test.ts]\n---\n# Repository Map\n',
    );

    const context = await service.getContext('indexed', 5000);

    expect(context.indexManifest).toMatchObject({
      repository_map: 'Repository Map.md',
      ownership: 'Ownership.md',
    });
    expect(
      context.notes.find((note) => note.role === 'repository_map'),
    ).toMatchObject({
      exists: true,
      metadata: {
        status: 'verified',
        repository_revision: 'abc123',
        owners: ['platform'],
        related_paths: [
          'src/server.ts',
          'tests/integration/server.integration.test.ts',
        ],
      },
      verification: { stale: true, gaps: [] },
    });
    expect(context.missing).toContain('Ownership.md');
    expect(context.verificationGaps).toContainEqual(
      expect.objectContaining({ role: 'ownership', reason: 'missing_note' }),
    );
  });
  it('returns canonical project notes and reports missing notes without failing', async () => {
    const { root, service } = await makeService();
    await writeFile(
      path.join(root, '00 - Project Home.md'),
      '# Testing\n\nCurrent focus: connector context.\n',
    );
    await writeFile(
      path.join(root, '06 - Tasks.md'),
      '- [ ] Add context tool\n- [x] Define vault layout\n',
    );

    const context = await service.getContext('testing', 5000);

    expect(context.vault).toBe('testing');
    expect(
      context.notes.find((note) => note.path === '00 - Project Home.md'),
    ).toMatchObject({
      exists: true,
      content: expect.stringContaining('connector context'),
    });
    expect(
      context.notes.find((note) => note.path === '01 - Brief.md'),
    ).toMatchObject({ exists: false });
  });

  it('extracts open and completed tasks plus recent daily notes', async () => {
    const { root, service } = await makeService();
    await mkdir(path.join(root, 'Daily'));
    await writeFile(
      path.join(root, '06 - Tasks.md'),
      '- [ ] Add context tool\n- [x] Define vault layout\n',
    );
    await writeFile(
      path.join(root, '04 - Decisions.md'),
      '## 2026-07-31 — Context\n\nUse bounded read-only tools.\n',
    );
    await writeFile(
      path.join(root, 'Daily', '2026-07-31.md'),
      'Worked on project context extraction.\n',
    );

    const activity = await service.getActivity('testing', 5, 5000);

    expect(activity.tasks).toEqual([
      { completed: false, text: 'Add context tool', source: '06 - Tasks.md' },
      { completed: true, text: 'Define vault layout', source: '06 - Tasks.md' },
    ]);
    expect(activity.decisions[0]).toMatchObject({
      source: '04 - Decisions.md',
      content: expect.stringContaining('Use bounded read-only tools'),
    });
    expect(activity.dailyNotes[0]).toMatchObject({
      source: 'Daily/2026-07-31.md',
      content: expect.stringContaining('context extraction'),
    });
  });

  it('extracts project activity from configured role paths', async () => {
    const { root, service } = await makeRoleMappedService();
    await mkdir(path.join(root, '04 - Plans & Specs'), { recursive: true });
    await mkdir(path.join(root, '01 - Business Plan'), { recursive: true });
    await mkdir(path.join(root, '06 - Repository Reference'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, '04 - Plans & Specs', 'Tasks.md'),
      '- [ ] Reconcile PAYG wallet\n- [x] Outline activity extraction\n',
    );
    await writeFile(
      path.join(root, '04 - Plans & Specs', 'Decisions.md'),
      '## Wallet Layout\n\nTrack PAYG work in plans and specs.\n',
    );
    await writeFile(
      path.join(root, '01 - Business Plan', 'Risks.md'),
      '## Funding Risk\n\nWallet balance can block PAYG rollout.\n',
    );
    await writeFile(
      path.join(root, '06 - Repository Reference', 'Changelog.md'),
      '## 2026-09-05\n\nMapped project activity roles.\n',
    );

    const activity = await service.getActivity('mapped', 5, 5000);

    expect(activity.tasks).toEqual([
      {
        completed: false,
        text: 'Reconcile PAYG wallet',
        source: '04 - Plans & Specs/Tasks.md',
      },
      {
        completed: true,
        text: 'Outline activity extraction',
        source: '04 - Plans & Specs/Tasks.md',
      },
    ]);
    expect(activity.decisions[0]).toMatchObject({
      source: '04 - Plans & Specs/Decisions.md',
      content: expect.stringContaining('Track PAYG work'),
    });
    expect(activity.risks[0]).toMatchObject({
      source: '01 - Business Plan/Risks.md',
      content: expect.stringContaining('Wallet balance'),
    });
    expect(activity.changelog[0]).toMatchObject({
      source: '06 - Repository Reference/Changelog.md',
      content: expect.stringContaining('Mapped project activity roles'),
    });
  });
});
