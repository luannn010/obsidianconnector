import { describe, expect, it, vi } from 'vitest';
import {
  registerProjectWorktree,
  type ProjectSetupPool,
} from '../../src/setup/project-registration.js';

function input() {
  return {
    projectKey: 'Host-Mesh',
    name: 'Host Mesh',
    vaultName: 'Host-Mesh',
    vaultRelativePath: 'Host-Mesh',
    repositoryPath: 'D:\\Host-Mesh',
    branch: 'main',
    head: 'a'.repeat(40),
    dirtyHash: 'dirty',
    dirtyPaths: ['AGENTS.md'],
  };
}

describe('project setup registration', () => {
  it('creates one project, repository, and primary worktree transactionally', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('SELECT project_id,vault_name')) return { rows: [] };
        if (sql.includes('INSERT INTO project_knowledge.projects'))
          return { rows: [{ project_id: 'p1' }] };
        if (sql.includes('SELECT id,root_path')) return { rows: [] };
        if (sql.includes('INSERT INTO project_knowledge.repositories'))
          return { rows: [{ id: 'r1' }] };
        if (sql.includes('INSERT INTO project_knowledge.worktrees'))
          return { rows: [{ id: 'w1' }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client } as unknown as ProjectSetupPool;

    await expect(registerProjectWorktree(pool, input())).resolves.toEqual({
      projectId: 'p1',
      repositoryId: 'r1',
      worktreeId: 'w1',
      projectCreated: true,
    });
    expect(statements).toContain('BEGIN');
    expect(statements).toContain('COMMIT');
  });

  it('rejects rebinding a project key to another vault', async () => {
    const client = {
      query: vi.fn(async (sql: string) =>
        sql.includes('SELECT project_id,vault_name')
          ? {
              rows: [
                {
                  project_id: 'p1',
                  vault_name: 'Other',
                  vault_relative_path: 'Other',
                },
              ],
            }
          : { rows: [] },
      ),
      release: vi.fn(),
    };
    const pool = { connect: async () => client } as unknown as ProjectSetupPool;

    await expect(registerProjectWorktree(pool, input())).rejects.toThrow(
      'different vault',
    );
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('binds a project registered before vault tracking to the vault', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT project_id,vault_name'))
          return {
            rows: [
              { project_id: 'p1', vault_name: '', vault_relative_path: '' },
            ],
          };
        if (sql.includes('SELECT id,root_path'))
          return { rows: [{ id: 'r1', root_path: 'D:\\Host-Mesh' }] };
        if (sql.includes('INSERT INTO project_knowledge.worktrees'))
          return { rows: [{ id: 'w1' }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client } as unknown as ProjectSetupPool;

    await expect(registerProjectWorktree(pool, input())).resolves.toMatchObject(
      {
        projectId: 'p1',
        projectCreated: false,
      },
    );
    const update = calls.find((call) =>
      call.sql.includes('UPDATE project_knowledge.projects'),
    );
    expect(update?.sql).toContain("vault_name=CASE WHEN vault_name=''");
    expect(update?.params).toEqual([
      'p1',
      'Host Mesh',
      'Host-Mesh',
      'Host-Mesh',
    ]);
  });

  it('rejects rebinding a project key to another repository', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT project_id,vault_name'))
          return {
            rows: [
              {
                project_id: 'p1',
                vault_name: 'Host-Mesh',
                vault_relative_path: 'Host-Mesh',
              },
            ],
          };
        if (sql.includes('SELECT id,root_path'))
          return { rows: [{ id: 'r2', root_path: 'C:\\Other' }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client } as unknown as ProjectSetupPool;

    await expect(registerProjectWorktree(pool, input())).rejects.toThrow(
      'different repository',
    );
  });
});
