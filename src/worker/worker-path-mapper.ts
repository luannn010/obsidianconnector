import path from 'node:path';

export function mapWindowsPathToContainer(
  hostPath: string,
  hostRoot: string,
  containerRoot: string,
): string {
  const relative = path.win32.relative(
    path.win32.resolve(hostRoot),
    path.win32.resolve(hostPath),
  );
  if (
    relative === '..' ||
    relative.startsWith(`..${path.win32.sep}`) ||
    path.win32.isAbsolute(relative)
  )
    throw new Error(
      'Registered worktree is outside the configured projects root',
    );
  return path.posix.resolve(
    containerRoot,
    ...relative.split(path.win32.sep).filter(Boolean),
  );
}

export function mapPortableRelativePathToContainer(
  relativePath: string,
  containerRoot: string,
): string {
  const normalized = relativePath.replace(/\\/gu, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Configured path must be a portable relative path');
  }
  return path.posix.join(containerRoot, normalized);
}
