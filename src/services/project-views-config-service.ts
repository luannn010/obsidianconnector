import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

const viewSchema = z.object({
  renderer: z.string().trim().min(1),
  path: z.string().trim().min(1).optional(),
  pathTemplate: z.string().trim().min(1).optional(),
  instances: z.string().trim().min(1).optional(),
  mode: z.enum(['lazy', 'eager']).optional(),
  limits: z.record(z.string(), z.number().int().positive()).optional(),
});

const projectViewsConfigSchema = z.object({
  schemaVersion: z.literal(1),
  projectionMode: z.enum(['lazy', 'eager']).default('lazy'),
  views: z.record(z.string(), viewSchema),
});

export type ProjectViewsConfig = z.infer<typeof projectViewsConfigSchema>;

export const DEFAULT_PROJECT_VIEWS_CONFIG: ProjectViewsConfig = {
  schemaVersion: 1,
  projectionMode: 'lazy',
  views: {
    'project-now': {
      renderer: 'project-now',
      path: 'Published/00 - Now.md',
    },
    'worktree-now': {
      renderer: 'worktree-now',
      pathTemplate: 'Published/Worktrees/{branchSlug}--{worktreeId8}/Now.md',
      instances: 'live-git-worktrees',
    },
  },
};

export function defaultProjectViewsConfigContent(): string {
  return stringify(DEFAULT_PROJECT_VIEWS_CONFIG, {
    sortMapEntries: false,
    lineWidth: 0,
  });
}

export async function readProjectViewsConfig(
  projectRoot: string,
): Promise<ProjectViewsConfig | undefined> {
  const filename = path.join(projectRoot, '.obsidian-local', 'views.yaml');
  const content = await readFile(filename, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  return content === undefined
    ? undefined
    : projectViewsConfigSchema.parse(parse(content));
}

export function isLazyProjectionMode(
  config: ProjectViewsConfig | undefined,
): boolean {
  return config?.projectionMode === 'lazy';
}
