import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import {
  loadProjectKnowledgeEnvironment,
  VaultRegistry,
} from './config/registry.js';
import { knowledgeMigrations } from './knowledge/migrations.js';
import {
  applyKnowledgeMigrations,
  type PgPoolLike,
} from './knowledge/pg-store.js';
import { FilesystemService } from './services/filesystem-service.js';
import { ProjectBootstrapService } from './services/project-bootstrap-service.js';
import { ProjectMappingService } from './services/project-mapping-service.js';
import {
  createMissingStarterNotes,
  ensureGitHead,
  resolvePortableSetupPaths,
} from './setup/project-setup-service.js';
import {
  registerProjectWorktree,
  type ProjectSetupPool,
} from './setup/project-registration.js';
import { fingerprintWorktree } from './worker/git-worktree.js';
import { SharedJobQueue } from './worker/shared-job-queue.js';

export interface SetupArguments {
  projectPath?: string;
  vaultPath?: string;
  projectsRoot?: string;
  vaultRoot?: string;
  projectKey?: string;
  name?: string;
  configPath?: string;
  whatIf: boolean;
}

const valueFlags = new Set([
  '--project-path',
  '--vault-path',
  '--projects-root',
  '--vault-root',
  '--project-key',
  '--name',
  '--config-path',
]);

export function parseSetupArguments(args: string[]): SetupArguments {
  const parsed: SetupArguments = { whatIf: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--what-if') {
      parsed.whatIf = true;
      continue;
    }
    if (!valueFlags.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === '--project-path') parsed.projectPath = value;
    else if (flag === '--vault-path') parsed.vaultPath = value;
    else if (flag === '--projects-root') parsed.projectsRoot = value;
    else if (flag === '--vault-root') parsed.vaultRoot = value;
    else if (flag === '--project-key') parsed.projectKey = value;
    else if (flag === '--name') parsed.name = value;
    else if (flag === '--config-path') parsed.configPath = value;
  }
  return parsed;
}

export function defaultSetupIdentity(vaultPath: string): {
  projectKey: string;
  name: string;
  vaultName: string;
} {
  const vaultName = path.win32.basename(path.win32.resolve(vaultPath));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(vaultName))
    throw new Error('Vault directory name is not a valid default project key');
  return { projectKey: vaultName, name: vaultName, vaultName };
}

export function redactDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    return url.toString().replace(/%2A%2A%2A/giu, '***');
  } catch {
    return '<redacted database connection>';
  }
}

function dirtyPaths(status: string): string[] {
  return status
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.slice(3).trim().split(' -> ').at(-1)!)
    .filter(Boolean)
    .sort();
}

async function exists(directory: string): Promise<boolean> {
  return (await stat(directory).catch(() => undefined))?.isDirectory() ?? false;
}

async function runSetup(
  args: SetupArguments,
): Promise<Record<string, unknown>> {
  if (!args.projectPath || !args.vaultPath)
    throw new Error('--project-path and --vault-path are required');
  const identity = defaultSetupIdentity(args.vaultPath);
  const projectKey = args.projectKey ?? identity.projectKey;
  const name = args.name ?? identity.name;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(projectKey))
    throw new Error(
      'Project key must contain only letters, digits, dots, underscores, and hyphens',
    );
  const projectsRoot =
    args.projectsRoot ??
    path.win32.dirname(path.win32.resolve(args.projectPath));
  const vaultRoot =
    args.vaultRoot ??
    process.env.OBSIDIAN_VAULT_ROOT ??
    'G:\\My Drive\\.obsidian';
  const portable = resolvePortableSetupPaths({
    projectPath: args.projectPath,
    projectsRoot,
    vaultPath: args.vaultPath,
    vaultRoot,
  });
  const databaseUrl = process.env.PROJECT_KNOWLEDGE_DATABASE_URL?.trim();
  const migrationDatabaseUrl =
    process.env.PROJECT_KNOWLEDGE_MIGRATION_DATABASE_URL?.trim() || databaseUrl;

  if (args.whatIf) {
    let databaseConnected = false;
    if (databaseUrl) {
      const probe = new Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 5_000,
      });
      try {
        await probe.query('SELECT 1');
        databaseConnected = true;
      } finally {
        await probe.end();
      }
    }
    return {
      mode: 'what-if',
      projectKey,
      name,
      vaultName: identity.vaultName,
      ...portable,
      database: {
        configured: Boolean(databaseUrl),
        connected: databaseConnected,
        endpoint: databaseUrl ? redactDatabaseUrl(databaseUrl) : null,
      },
      operations: [
        'apply_migrations',
        'register_vault',
        'create_project_config',
        'create_missing_starter_notes',
        'ensure_git_head',
        'register_project_worktree',
        'enqueue_source_sync',
      ],
    };
  }

  if (!databaseUrl)
    throw new Error('PROJECT_KNOWLEDGE_DATABASE_URL is required');
  if (!migrationDatabaseUrl)
    throw new Error(
      'PROJECT_KNOWLEDGE_MIGRATION_DATABASE_URL is required to initialize the schema',
    );
  if (!(await exists(portable.projectPath)))
    throw new Error('Project directory does not exist');
  await mkdir(portable.vaultPath, { recursive: true });

  const migrationPool = new Pool({
    connectionString: migrationDatabaseUrl,
    max: 1,
  });
  try {
    await applyKnowledgeMigrations(
      migrationPool as unknown as PgPoolLike,
      knowledgeMigrations,
    );
  } finally {
    await migrationPool.end();
  }

  const configPath = args.configPath
    ? path.resolve(args.configPath)
    : path.resolve(process.cwd(), 'config', 'vaults.json');
  const registry = await VaultRegistry.load(configPath, {
    vaultRoot: portable.vaultRoot,
  });
  const existingVault = registry
    .list()
    .find((vault) => vault.name === identity.vaultName);
  if (existingVault) {
    const [registeredPath, requestedPath] = await Promise.all([
      realpath(existingVault.path),
      realpath(portable.vaultPath),
    ]);
    if (
      registeredPath.toLocaleLowerCase() !== requestedPath.toLocaleLowerCase()
    )
      throw new Error(
        `Vault ${identity.vaultName} is already registered to a different path`,
      );
  } else {
    await registry.register(identity.vaultName, portable.vaultPath);
  }
  const files = new FilesystemService(registry);
  const bootstrap = new ProjectBootstrapService(
    registry,
    new ProjectMappingService(registry, files),
    files,
  );
  const projectConfiguration = await bootstrap.initialize(
    portable.projectPath,
    identity.vaultName,
    false,
  );
  const starterNotes = await createMissingStarterNotes(
    files,
    identity.vaultName,
    name,
  );
  const git = await ensureGitHead(portable.projectPath);
  const fingerprint = await fingerprintWorktree(portable.projectPath);

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: 'project-setup',
  });
  try {
    const registration = await registerProjectWorktree(
      pool as unknown as ProjectSetupPool,
      {
        projectKey,
        name,
        vaultName: identity.vaultName,
        vaultRelativePath: portable.vaultRelativePath,
        repositoryPath: portable.projectPath,
        branch: fingerprint.branch,
        head: fingerprint.head,
        dirtyHash: fingerprint.dirtyHash,
        dirtyPaths: dirtyPaths(fingerprint.status),
      },
    );
    const queued = await new SharedJobQueue(pool).enqueueSourceSync(
      registration.projectId,
      registration.worktreeId,
      'on_demand',
    );
    return {
      mode: 'apply',
      projectKey,
      name,
      vaultName: identity.vaultName,
      vaultRelativePath: portable.vaultRelativePath,
      database: { connected: true, endpoint: redactDatabaseUrl(databaseUrl) },
      projectCreated: registration.projectCreated,
      projectId: registration.projectId,
      repositoryId: registration.repositoryId,
      worktreeId: registration.worktreeId,
      jobId: queued.jobId,
      jobCreated: queued.created,
      fingerprint: { head: fingerprint.head, dirtyHash: fingerprint.dirtyHash },
      git,
      configuration: projectConfiguration.files,
      starterNotes,
    };
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const connectorRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  loadProjectKnowledgeEnvironment(connectorRoot);
  try {
    console.log(
      JSON.stringify(
        await runSetup(parseSetupArguments(process.argv.slice(2))),
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const databaseUrl = process.env.PROJECT_KNOWLEDGE_DATABASE_URL;
    console.error(
      JSON.stringify({
        state: 'failed',
        error: databaseUrl
          ? message.replaceAll(databaseUrl, '<redacted database connection>')
          : message,
      }),
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
