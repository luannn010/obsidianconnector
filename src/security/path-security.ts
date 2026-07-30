import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { SecurityError } from './errors.js';

export { SecurityError } from './errors.js';

export interface ResolvePathOptions {
  kind: 'note' | 'directory';
  allowMissing?: boolean;
}

const excludedNames = new Set(['.obsidian', '.trash', 'node_modules']);

function isAbsolute(input: string): boolean {
  return (
    path.isAbsolute(input) ||
    path.win32.isAbsolute(input) ||
    path.posix.isAbsolute(input)
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  const normalized = relative.split(path.sep).filter(Boolean);
  return normalized[0] !== '..';
}

function validateRelativePath(
  relativePath: string,
  options: ResolvePathOptions,
): string[] {
  if (relativePath.includes('\0')) {
    throw new SecurityError('NULL_BYTE', 'Path contains a null byte');
  }
  if (isAbsolute(relativePath)) {
    throw new SecurityError(
      'ABSOLUTE_PATH',
      'Path must be relative to the registered vault',
    );
  }
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new SecurityError('TRAVERSAL', 'Path traversal is not allowed');
  }
  if (
    options.kind === 'note' &&
    !segments.at(-1)?.toLowerCase().endsWith('.md')
  ) {
    throw new SecurityError('MARKDOWN_REQUIRED', 'Note paths must end in .md');
  }
  const directorySegments =
    options.kind === 'directory' ? segments : segments.slice(0, -1);
  if (
    segments.some((segment) => excludedNames.has(segment.toLowerCase())) ||
    directorySegments.some((segment) => segment.startsWith('.'))
  ) {
    throw new SecurityError(
      'EXCLUDED_PATH',
      'Access to this path is not allowed',
    );
  }
  return segments;
}

export async function resolveVaultPath(
  vaultRoot: string,
  relativePath: string,
  options: ResolvePathOptions,
): Promise<string> {
  const segments = validateRelativePath(relativePath, options);
  const canonicalRoot = await realpath(vaultRoot);
  let current = canonicalRoot;

  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      current = await realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!options.allowMissing) {
        throw new SecurityError('NOT_FOUND', 'Path does not exist');
      }
      current = path.join(current, ...segments.slice(index + 1));
      break;
    }
    if (!isWithin(canonicalRoot, current)) {
      throw new SecurityError(
        'OUTSIDE_VAULT',
        'Path resolves outside the registered vault',
      );
    }
  }

  if (!isWithin(canonicalRoot, current)) {
    throw new SecurityError(
      'OUTSIDE_VAULT',
      'Path resolves outside the registered vault',
    );
  }
  if (options.kind === 'directory') {
    await access(current).catch(() => {
      if (!options.allowMissing)
        throw new SecurityError('NOT_FOUND', 'Path does not exist');
    });
  }
  return current;
}
