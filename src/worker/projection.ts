import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import { stringify } from 'yaml';
import { projectionHash } from '../knowledge/hash.js';

export interface ManagedNoteInput {
  viewId: string;
  projectId: string;
  viewType: string;
  dbRevision: number;
  gitRevision?: string;
  body: string;
  generatedAt?: string;
  metadata?: Record<string, unknown>;
}

export function renderManagedNote(input: ManagedNoteInput): string {
  const base = {
    db_revision: input.dbRevision,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    ...(input.gitRevision ? { git_revision: input.gitRevision } : {}),
    managed: true,
    project_id: input.projectId,
    projection_hash: '',
    sync_status: 'current',
    view_id: input.viewId,
    view_type: input.viewType,
    ...(input.metadata ?? {}),
  };
  const preliminary = `---\n${stringify(base, { sortMapEntries: true, lineWidth: 0 }).trimEnd()}\n---\n${input.body.trimEnd()}\n`;
  const finalData = { ...base, projection_hash: projectionHash(preliminary) };
  return `---\n${stringify(finalData, { sortMapEntries: true, lineWidth: 0 }).trimEnd()}\n---\n${input.body.trimEnd()}\n`;
}

function safeTarget(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), target);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Projection path escapes the vault root');
  }
  return target;
}

function isIntactManagedProjection(
  markdown: string,
  currentHash: string,
): boolean {
  try {
    const frontmatter = matter(markdown).data;
    return (
      frontmatter.managed === true &&
      frontmatter.projection_hash === currentHash
    );
  } catch {
    return false;
  }
}

export async function publishProjection(
  vaultRoot: string,
  relativePath: string,
  rendered: string,
  lastPublishedHash?: string,
  knownDrift?: {
    desiredHash: string;
    observedHash: string;
    preservedPath: string;
  },
): Promise<{
  state: 'current' | 'drifted';
  observedHash: string;
  preservedPath?: string;
  conflictCreated?: boolean;
}> {
  const target = safeTarget(vaultRoot, relativePath);
  const current = await readFile(target, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (current !== undefined) {
    const currentHash = projectionHash(current);
    if (
      lastPublishedHash &&
      currentHash !== lastPublishedHash &&
      currentHash !== projectionHash(rendered)
    ) {
      if (!isIntactManagedProjection(current, currentHash)) {
        if (
          knownDrift?.observedHash === currentHash &&
          knownDrift.desiredHash === projectionHash(rendered)
        )
          return {
            state: 'drifted',
            observedHash: currentHash,
            preservedPath: knownDrift.preservedPath,
            conflictCreated: false,
          };
        const conflict = safeTarget(
          vaultRoot,
          path.join(
            'Inbox',
            'Conflicts',
            `${Date.now()}-${path.basename(relativePath)}`,
          ),
        );
        await mkdir(path.dirname(conflict), { recursive: true });
        await writeFile(conflict, current, 'utf8');
        return {
          state: 'drifted',
          observedHash: currentHash,
          preservedPath: conflict,
          conflictCreated: true,
        };
      }
    }
    if (currentHash === projectionHash(rendered))
      return { state: 'current', observedHash: currentHash };
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, rendered, 'utf8');
  await rename(temporary, target);
  const observedHash = projectionHash(await readFile(target, 'utf8'));
  return { state: 'current', observedHash };
}

export async function removeProjection(
  vaultRoot: string,
  relativePath: string,
  lastPublishedHash?: string,
): Promise<{ removed: boolean; preservedPath?: string }> {
  const target = safeTarget(vaultRoot, relativePath);
  const current = await readFile(target, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (current === undefined) return { removed: false };

  let preservedPath: string | undefined;
  if (projectionHash(current) !== lastPublishedHash) {
    const conflict = safeTarget(
      vaultRoot,
      path.join(
        'Inbox',
        'Conflicts',
        `${Date.now()}-retired-${path.basename(relativePath)}`,
      ),
    );
    await mkdir(path.dirname(conflict), { recursive: true });
    await writeFile(conflict, current, 'utf8');
    preservedPath = conflict;
  }
  await unlink(target);
  return { removed: true, ...(preservedPath ? { preservedPath } : {}) };
}

export async function archiveProjection(
  vaultRoot: string,
  relativePath: string,
  archiveRelativePath: string,
  lastPublishedHash?: string,
): Promise<{
  archived: boolean;
  conflicted: boolean;
  archivePath?: string;
  preservedPath?: string;
  observedHash?: string;
}> {
  const source = safeTarget(vaultRoot, relativePath);
  const current = await readFile(source, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (current === undefined) return { archived: false, conflicted: false };

  const observedHash = projectionHash(current);
  if (
    !lastPublishedHash ||
    observedHash !== lastPublishedHash ||
    !isIntactManagedProjection(current, observedHash)
  ) {
    const conflict = safeTarget(
      vaultRoot,
      path.join(
        'Inbox',
        'Conflicts',
        `${Date.now()}-archive-${path.basename(relativePath)}`,
      ),
    );
    await mkdir(path.dirname(conflict), { recursive: true });
    await writeFile(conflict, current, 'utf8');
    return {
      archived: false,
      conflicted: true,
      preservedPath: conflict,
      observedHash,
    };
  }

  let archivePath = archiveRelativePath;
  let target = safeTarget(vaultRoot, archivePath);
  const occupied = await readFile(target, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (occupied !== undefined) {
    const parsed = path.parse(archiveRelativePath);
    archivePath = path.join(
      parsed.dir,
      `${parsed.name}-${Date.now()}${parsed.ext}`,
    );
    target = safeTarget(vaultRoot, archivePath);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await rename(source, target);
  return {
    archived: true,
    conflicted: false,
    archivePath,
    observedHash,
  };
}
