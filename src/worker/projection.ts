import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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

export async function publishProjection(
  vaultRoot: string,
  relativePath: string,
  rendered: string,
  lastPublishedHash?: string,
): Promise<{
  state: 'current' | 'drifted';
  observedHash: string;
  preservedPath?: string;
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
      };
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
