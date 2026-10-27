import path from 'node:path';

export interface ProjectSetupClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount?: number | null }>;
  release(): void;
}

export interface ProjectSetupPool {
  connect(): Promise<ProjectSetupClient>;
}

export interface ProjectRegistrationInput {
  projectKey: string;
  name: string;
  vaultName: string;
  vaultRelativePath: string;
  repositoryPath: string;
  branch: string;
  head: string;
  dirtyHash: string | null;
  dirtyPaths: string[];
}

function sameWindowsPath(left: string, right: string): boolean {
  return (
    path.win32.resolve(left).toLocaleLowerCase() ===
    path.win32.resolve(right).toLocaleLowerCase()
  );
}

export async function registerProjectWorktree(
  pool: ProjectSetupPool,
  input: ProjectRegistrationInput,
): Promise<{
  projectId: string;
  repositoryId: string;
  worktreeId: string;
  projectCreated: boolean;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = (
      await client.query<{
        project_id: string;
        vault_name: string;
        vault_relative_path: string;
      }>(
        `SELECT project_id,vault_name,vault_relative_path
         FROM project_knowledge.projects WHERE project_key=$1 FOR UPDATE`,
        [input.projectKey],
      )
    ).rows[0];
    // Projects registered before vault tracking have an empty binding; adopt it.
    const unbound = existing?.vault_name === '';
    if (
      existing &&
      !unbound &&
      (existing.vault_name !== input.vaultName ||
        existing.vault_relative_path !== input.vaultRelativePath)
    ) {
      throw new Error(
        `Project key ${input.projectKey} is already registered to a different vault`,
      );
    }
    const projectCreated = !existing;
    const projectId =
      existing?.project_id ??
      (
        await client.query<{ project_id: string }>(
          `INSERT INTO project_knowledge.projects
           (project_key,name,vault_name,vault_relative_path)
         VALUES($1,$2,$3,$4) RETURNING project_id`,
          [
            input.projectKey,
            input.name,
            input.vaultName,
            input.vaultRelativePath,
          ],
        )
      ).rows[0]!.project_id;
    if (existing) {
      await client.query(
        `UPDATE project_knowledge.projects
         SET name=$2,
             vault_name=CASE WHEN vault_name='' THEN $3 ELSE vault_name END,
             vault_relative_path=CASE WHEN vault_name='' THEN $4
                                      ELSE vault_relative_path END,
             updated_at=now()
         WHERE project_id=$1`,
        [projectId, input.name, input.vaultName, input.vaultRelativePath],
      );
    }

    const repositories = (
      await client.query<{ id: string; root_path: string }>(
        `SELECT id,root_path FROM project_knowledge.repositories
         WHERE project_id=$1 FOR UPDATE`,
        [projectId],
      )
    ).rows;
    const matchingRepository = repositories.find((repository) =>
      sameWindowsPath(repository.root_path, input.repositoryPath),
    );
    if (repositories.length > 0 && !matchingRepository) {
      throw new Error(
        `Project key ${input.projectKey} is already registered to a different repository`,
      );
    }
    const repositoryId =
      matchingRepository?.id ??
      (
        await client.query<{ id: string }>(
          `INSERT INTO project_knowledge.repositories
           (project_id,name,root_path,default_branch)
         VALUES($1,$2,$3,$4) RETURNING id`,
          [projectId, input.name, input.repositoryPath, input.branch],
        )
      ).rows[0]!.id;
    if (matchingRepository) {
      await client.query(
        `UPDATE project_knowledge.repositories
         SET name=$2,default_branch=$3 WHERE id=$1`,
        [repositoryId, input.name, input.branch],
      );
    }

    const worktreeId = (
      await client.query<{ id: string }>(
        `INSERT INTO project_knowledge.worktrees
           (project_id,repository_id,path,branch,head_commit,dirty_hash,dirty_paths,registered)
         VALUES($1,$2,$3,$4,$5,$6,$7,true)
         ON CONFLICT(project_id,path) DO UPDATE SET
           repository_id=EXCLUDED.repository_id,branch=EXCLUDED.branch,
           head_commit=EXCLUDED.head_commit,dirty_hash=EXCLUDED.dirty_hash,
           dirty_paths=EXCLUDED.dirty_paths,registered=true,last_seen_at=now()
         RETURNING id`,
        [
          projectId,
          repositoryId,
          input.repositoryPath,
          input.branch,
          input.head,
          input.dirtyHash,
          input.dirtyPaths,
        ],
      )
    ).rows[0]!.id;
    await client.query('COMMIT');
    return { projectId, repositoryId, worktreeId, projectCreated };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
