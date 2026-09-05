import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { sourceHash } from '../knowledge/hash.js';

const execFileAsync = promisify(execFile);
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.sql',
  '.md',
  '.yaml',
  '.yml',
  '.toml',
  '.go',
  '.py',
  '.rs',
  '.java',
  '.kt',
  '.cs',
  '.sh',
  '.ps1',
  '.css',
  '.scss',
  '.html',
]);
const EXCLUDED_PARTS = new Set([
  '.git',
  '.obsidian',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  'target',
  'vendor',
  '.cache',
]);

export interface ChangedPath {
  status: 'A' | 'M' | 'D' | 'R';
  path: string;
  previousPath?: string;
}
export interface WorktreeFingerprint {
  root: string;
  branch: string;
  head: string;
  dirtyHash: string | null;
  status: string;
}
export interface RegisteredWorktree {
  path: string;
  branch: string;
  head: string;
}

export function parseWorktreeList(output: string): RegisteredWorktree[] {
  return output
    .trim()
    .split(/\r?\n\r?\n/u)
    .filter(Boolean)
    .flatMap((block) => {
      const fields = Object.fromEntries(
        block.split(/\r?\n/u).map((line) => {
          const split = line.indexOf(' ');
          return split < 0
            ? [line, '']
            : [line.slice(0, split), line.slice(split + 1)];
        }),
      );
      return fields.worktree && fields.HEAD
        ? [
            {
              path: fields.worktree,
              head: fields.HEAD,
              branch: (fields.branch ?? 'detached').replace(
                /^refs\/heads\//u,
                '',
              ),
            },
          ]
        : [];
    });
}

export async function listRegisteredWorktrees(
  root: string,
): Promise<RegisteredWorktree[]> {
  return parseWorktreeList(
    await git(root, ['worktree', 'list', '--porcelain']),
  );
}

export function shouldIndexPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/gu, '/');
  const parts = normalized.split('/');
  if (parts.some((part) => EXCLUDED_PARTS.has(part))) return false;
  if (
    parts.some(
      (part) =>
        /^\.env(?:\.|$)/u.test(part) || /(?:credential|secret)/iu.test(part),
    )
  )
    return false;
  return TEXT_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

export function parseGitNameStatus(output: string): ChangedPath[] {
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      const fields = line.split('\t');
      const raw = fields[0] ?? '';
      const status = raw[0] as ChangedPath['status'];
      if (status === 'R' && fields[1] && fields[2])
        return [{ status, previousPath: fields[1], path: fields[2] }];
      if (['A', 'M', 'D'].includes(status) && fields[1])
        return [{ status, path: fields[1] }];
      return [];
    });
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

export async function fingerprintWorktree(
  root: string,
): Promise<WorktreeFingerprint> {
  const resolved = path.resolve(root);
  const [top, branch, head, status] = await Promise.all([
    git(resolved, ['rev-parse', '--show-toplevel']),
    git(resolved, ['branch', '--show-current']),
    git(resolved, ['rev-parse', 'HEAD']),
    git(resolved, ['status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  if (path.resolve(top) !== resolved)
    throw new Error('Configured repository path is not the worktree root');
  return {
    root: resolved,
    branch,
    head,
    status,
    dirtyHash: status ? sourceHash(status) : null,
  };
}

export async function listIndexableFiles(root: string): Promise<string[]> {
  const tracked = (await git(root, ['ls-files']))
    .split(/\r?\n/u)
    .filter(Boolean);
  const untracked = (
    await git(root, ['ls-files', '--others', '--exclude-standard'])
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])]
    .filter(shouldIndexPath)
    .sort();
}

export async function changedIndexableFiles(
  root: string,
  previousHead: string,
  currentHead: string,
  statusOutput: string,
): Promise<ChangedPath[]> {
  const committed =
    previousHead === currentHead
      ? []
      : parseGitNameStatus(
          await git(root, [
            'diff',
            '--name-status',
            `${previousHead}..${currentHead}`,
          ]),
        );
  const dirty = statusOutput
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line): ChangedPath | undefined => {
      const code = line.slice(0, 2).trim();
      const rawPath = line.slice(3).trim();
      const target = rawPath.includes(' -> ')
        ? rawPath.split(' -> ').at(-1)!
        : rawPath;
      if (!target) return undefined;
      return {
        status: code === '??' ? 'A' : code.includes('D') ? 'D' : 'M',
        path: target,
      };
    })
    .filter((entry): entry is ChangedPath => Boolean(entry));
  return [
    ...new Map(
      [...committed, ...dirty]
        .filter((entry) => shouldIndexPath(entry.path))
        .map((entry) => [entry.path, entry]),
    ).values(),
  ];
}
