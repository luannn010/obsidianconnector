import matter from 'gray-matter';
import { parse } from 'yaml';
import { z } from 'zod';
import type { VaultRegistry } from '../config/registry.js';
import {
  SecurityError,
  validateRelativePath,
} from '../security/path-security.js';
import type { FilesystemService } from './filesystem-service.js';

export const legacyContextNotes = [
  ['home', '00 - Project Home.md'],
  ['brief', '01 - Brief.md'],
  ['goals', '02 - Goals & Success Criteria.md'],
  ['requirements', '03 - Requirements.md'],
  ['decisions', '04 - Decisions.md'],
  ['plans', '05 - Plans.md'],
  ['tasks', '06 - Tasks.md'],
  ['research', '07 - Research.md'],
  ['meetings', '08 - Meeting Notes.md'],
  ['resources', '09 - Resources.md'],
  ['risks', '10 - Risks & Issues.md'],
  ['changelog', '11 - Changelog.md'],
] as const;

export interface ProjectMappingGroup {
  id: string;
  title: string;
  type: 'group';
  children: ProjectMappingNode[];
}

export interface ProjectMappingNote {
  id: string;
  title: string;
  type: 'note';
  path: string;
  alias?: string;
}

export type ProjectMappingNode = ProjectMappingGroup | ProjectMappingNote;

export interface ProjectMapping {
  schemaVersion: 1;
  vault: string;
  tree: ProjectMappingNode[];
}

export interface FlattenedProjectMapping {
  roles: Record<string, string>;
  aliases: Record<string, string>;
  notes: Array<{
    role: string;
    path: string;
    title: string;
    alias?: string;
  }>;
}

const mappingNodeSchema: z.ZodType<ProjectMappingNode> = z.lazy(() =>
  z.union([
    z.object({
      id: z.string().trim().min(1),
      title: z.string().trim().min(1),
      type: z.literal('group'),
      children: z.array(mappingNodeSchema).min(1),
    }),
    z.object({
      id: z.string().trim().min(1),
      title: z.string().trim().min(1),
      type: z.literal('note'),
      path: z.string().trim().min(1),
      alias: z.string().trim().min(1).optional(),
    }),
  ]),
);

const projectMappingSchema = z.object({
  schemaVersion: z.literal(1),
  vault: z.string().trim().min(1),
  tree: z.array(mappingNodeSchema),
});

function parseDocument(content: string): unknown {
  try {
    return parse(content);
  } catch (error) {
    throw new Error(
      `Invalid project mapping YAML: ${error instanceof Error ? error.message : 'parse error'}`,
    );
  }
}

function titleFromPath(relativePath: string): string {
  const filename = relativePath.split(/[\\/]/u).at(-1) ?? relativePath;
  return filename.replace(/\.md$/iu, '').replace(/[-_]+/gu, ' ');
}

function safeId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/gu, '_');
  return /^[A-Za-z]/u.test(normalized) ? normalized : `section_${normalized}`;
}

function addFlattenedNote(
  node: ProjectMappingNote,
  parentRole: string,
  state: {
    ids: Set<string>;
    paths: Set<string>;
    roles: Record<string, string>;
    aliases: Record<string, string>;
    notes: FlattenedProjectMapping['notes'];
  },
): void {
  const role = parentRole ? `${parentRole}.${node.id}` : node.id;
  validateRelativePath(node.path, { kind: 'note', allowMissing: true });
  if (state.paths.has(node.path))
    throw new Error(`Duplicate mapping path: ${node.path}`);
  state.paths.add(node.path);
  if (state.roles[role]) throw new Error(`Duplicate mapping role: ${role}`);
  state.roles[role] = node.path;
  if (node.alias) {
    if (state.aliases[node.alias])
      throw new Error(`Duplicate mapping alias: ${node.alias}`);
    state.aliases[node.alias] = role;
  }
  state.notes.push({
    role,
    path: node.path,
    title: node.title,
    ...(node.alias ? { alias: node.alias } : {}),
  });
}

function visitNode(
  node: ProjectMappingNode,
  parentRole: string,
  state: {
    ids: Set<string>;
    paths: Set<string>;
    roles: Record<string, string>;
    aliases: Record<string, string>;
    notes: FlattenedProjectMapping['notes'];
  },
): void {
  const role = parentRole ? `${parentRole}.${node.id}` : node.id;
  if (state.ids.has(node.id))
    throw new Error(`Duplicate mapping id: ${node.id}`);
  state.ids.add(node.id);
  if (node.type === 'note') {
    addFlattenedNote(node, parentRole, state);
    return;
  }
  for (const child of node.children) visitNode(child, role, state);
}

export function parseProjectMapping(content: string): ProjectMapping {
  const mapping = projectMappingSchema.parse(parseDocument(content));
  const flattened = flattenProjectMapping(mapping);
  if (flattened.notes.length === 0)
    throw new Error('Project mapping must contain at least one note');
  return mapping;
}

export function flattenProjectMapping(
  mapping: ProjectMapping,
): FlattenedProjectMapping {
  const state = {
    ids: new Set<string>(),
    paths: new Set<string>(),
    roles: {} as Record<string, string>,
    aliases: {} as Record<string, string>,
    notes: [] as FlattenedProjectMapping['notes'],
  };
  for (const node of mapping.tree) visitNode(node, '', state);
  return {
    roles: state.roles,
    aliases: state.aliases,
    notes: state.notes,
  };
}

function note(
  id: string,
  title: string,
  path: string,
  alias: string,
): ProjectMappingNote {
  return { id, title, type: 'note', path, alias };
}

export function createDefaultProjectMapping(vault: string): ProjectMapping {
  return {
    schemaVersion: 1,
    vault,
    tree: [
      {
        id: 'overview',
        title: 'Overview',
        type: 'group',
        children: [
          note('project_home', 'Project Home', '00 - Project Home.md', 'home'),
          note('brief', 'Brief', '01 - Brief.md', 'brief'),
          note(
            'goals',
            'Goals & Success Criteria',
            '02 - Goals & Success Criteria.md',
            'goals',
          ),
          note(
            'requirements',
            'Requirements',
            '03 - Requirements.md',
            'requirements',
          ),
        ],
      },
      {
        id: 'planning',
        title: 'Planning',
        type: 'group',
        children: [
          note('decisions', 'Decisions', '04 - Decisions.md', 'decisions'),
          note('plans', 'Plans', '05 - Plans.md', 'plans'),
          note('tasks', 'Tasks', '06 - Tasks.md', 'tasks'),
        ],
      },
      {
        id: 'knowledge',
        title: 'Knowledge',
        type: 'group',
        children: [
          note('research', 'Research', '07 - Research.md', 'research'),
          note(
            'meetings',
            'Meeting Notes',
            '08 - Meeting Notes.md',
            'meetings',
          ),
          note('resources', 'Resources', '09 - Resources.md', 'resources'),
        ],
      },
      {
        id: 'operations',
        title: 'Operations',
        type: 'group',
        children: [
          note('risks', 'Risks & Issues', '10 - Risks & Issues.md', 'risks'),
          note('changelog', 'Changelog', '11 - Changelog.md', 'changelog'),
        ],
      },
    ],
  };
}

function mappingFromRoles(
  vault: string,
  roles: Record<string, string>,
  aliases: Record<string, string>,
): ProjectMapping {
  const roots: ProjectMappingNode[] = [];
  const groups = new Map<string, ProjectMappingGroup>();
  const aliasByRole = new Map(
    Object.entries(aliases).map(([alias, role]) => [role, alias]),
  );

  for (const [role, path] of Object.entries(roles)) {
    const parts = role.split('.').filter(Boolean);
    let parent: ProjectMappingGroup | undefined;
    let parentRole = '';
    for (const [index, rawPart] of parts.slice(0, -1).entries()) {
      const part = safeId(rawPart);
      const groupRole = parentRole ? `${parentRole}.${part}` : part;
      let group = groups.get(groupRole);
      if (!group) {
        group = {
          id: part,
          title: rawPart.replace(/[-_]+/gu, ' '),
          type: 'group',
          children: [],
        };
        groups.set(groupRole, group);
        if (parent) parent.children.push(group);
        else roots.push(group);
      }
      parent = group;
      parentRole = groupRole;
      if (index === parts.length - 2) break;
    }
    const rawId = parts.at(-1) ?? role;
    const node: ProjectMappingNote = {
      id: safeId(rawId),
      title: titleFromPath(path),
      type: 'note',
      path,
      ...(aliasByRole.get(role) ? { alias: aliasByRole.get(role) } : {}),
    };
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return { schemaVersion: 1, vault, tree: roots };
}

function metadataRoles(content: string): Record<string, string> {
  const metadata = matter(content).data.roles;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return {};
  return Object.fromEntries(
    Object.entries(metadata).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function isMissing(error: unknown): boolean {
  return (
    (error instanceof SecurityError && error.code === 'NOT_FOUND') ||
    (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
  );
}

export class ProjectMappingService {
  constructor(
    private readonly registry: VaultRegistry,
    private readonly files: FilesystemService,
  ) {}

  async resolveIndex(vaultName: string): Promise<{
    roles: Record<string, string>;
    aliases: Record<string, string>;
  }> {
    const vault = this.registry.get(vaultName);
    let manifestRoles: Record<string, string> = {};
    try {
      const manifest = await this.files.readNote(
        vaultName,
        vault.codebaseIndex.manifest,
      );
      manifestRoles = metadataRoles(manifest.content);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const configuredRoles = vault.codebaseIndex.roles;
    return {
      roles:
        Object.keys(configuredRoles).length > 0
          ? { ...manifestRoles, ...configuredRoles }
          : {
              ...Object.fromEntries(legacyContextNotes),
              ...manifestRoles,
            },
      aliases: { ...vault.codebaseIndex.aliases },
    };
  }

  async mappingForVault(vaultName: string): Promise<ProjectMapping> {
    const vault = this.registry.get(vaultName);
    const resolved = await this.resolveIndex(vaultName);
    const hasCustomConfiguration =
      Object.keys(vault.codebaseIndex.roles).length > 0 ||
      Object.keys(vault.codebaseIndex.aliases).length > 0;
    if (!hasCustomConfiguration) {
      try {
        const manifest = await this.files.readNote(
          vaultName,
          vault.codebaseIndex.manifest,
        );
        if (Object.keys(metadataRoles(manifest.content)).length === 0)
          return createDefaultProjectMapping(vaultName);
      } catch (error) {
        if (!isMissing(error)) throw error;
        return createDefaultProjectMapping(vaultName);
      }
    }
    return mappingFromRoles(vaultName, resolved.roles, resolved.aliases);
  }
}

export function resolveSemanticPath(
  roles: Record<string, string>,
  aliases: Record<string, string>,
  semantic: string,
  fallback: string,
): string {
  const role = aliases[semantic] ?? semantic;
  return roles[role] ?? roles[semantic] ?? fallback;
}
