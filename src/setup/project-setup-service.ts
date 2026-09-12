import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { FilesystemService } from '../services/filesystem-service.js';
import { legacyContextNotes } from '../services/project-mapping-service.js';

const execFileAsync = promisify(execFile);

export interface PortableSetupPaths {
  projectPath: string;
  projectsRoot: string;
  projectRelativePath: string;
  vaultPath: string;
  vaultRoot: string;
  vaultRelativePath: string;
}

function relativeWithinWindowsRoot(
  candidate: string,
  root: string,
  label: string,
): string {
  const resolvedRoot = path.win32.resolve(root);
  const resolvedCandidate = path.win32.resolve(candidate);
  const relative = path.win32.relative(resolvedRoot, resolvedCandidate);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.win32.sep}`) ||
    path.win32.isAbsolute(relative)
  ) {
    throw new Error(`${label} must be a child of the configured ${label} root`);
  }
  return relative.split(path.win32.sep).join('/');
}

export function resolvePortableSetupPaths(input: {
  projectPath: string;
  projectsRoot: string;
  vaultPath: string;
  vaultRoot: string;
}): PortableSetupPaths {
  return {
    projectPath: path.win32.resolve(input.projectPath),
    projectsRoot: path.win32.resolve(input.projectsRoot),
    projectRelativePath: relativeWithinWindowsRoot(
      input.projectPath,
      input.projectsRoot,
      'project',
    ),
    vaultPath: path.win32.resolve(input.vaultPath),
    vaultRoot: path.win32.resolve(input.vaultRoot),
    vaultRelativePath: relativeWithinWindowsRoot(
      input.vaultPath,
      input.vaultRoot,
      'vault',
    ),
  };
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function hasGitRepository(root: string): Promise<boolean> {
  try {
    return (
      path
        .resolve(await git(root, ['rev-parse', '--show-toplevel']))
        .toLocaleLowerCase() === path.resolve(root).toLocaleLowerCase()
    );
  } catch {
    return false;
  }
}

async function currentHead(root: string): Promise<string | undefined> {
  try {
    return await git(root, ['rev-parse', 'HEAD']);
  } catch {
    return undefined;
  }
}

export async function ensureGitHead(root: string): Promise<{
  createdRepository: boolean;
  createdCommit: boolean;
  head: string;
}> {
  const resolved = path.resolve(root);
  const createdRepository = !(await hasGitRepository(resolved));
  if (createdRepository) await git(resolved, ['init']);
  let head = await currentHead(resolved);
  const createdCommit = !head;
  if (!head) {
    await git(resolved, [
      '-c',
      'user.name=Project Setup',
      '-c',
      'user.email=project-setup@localhost',
      'commit',
      '--allow-empty',
      '-m',
      'chore: initialize project knowledge',
    ]);
    head = await git(resolved, ['rev-parse', 'HEAD']);
  }
  return { createdRepository, createdCommit, head };
}

function starterContent(projectName: string, title: string): string {
  return `---\nproject: ${JSON.stringify(projectName)}\ntitle: ${JSON.stringify(title)}\n---\n\n# ${title}\n`;
}

export async function createMissingStarterNotes(
  files: FilesystemService,
  vault: string,
  projectName: string,
): Promise<{ created: string[]; preserved: string[] }> {
  const created: string[] = [];
  const preserved: string[] = [];
  for (const [, relativePath] of legacyContextNotes) {
    try {
      await files.createNote(
        vault,
        relativePath,
        starterContent(projectName, path.posix.basename(relativePath, '.md')),
      );
      created.push(relativePath);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Note already exists:')
      ) {
        preserved.push(relativePath);
        continue;
      }
      throw error;
    }
  }
  return { created, preserved };
}
