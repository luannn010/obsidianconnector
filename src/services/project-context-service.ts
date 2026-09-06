import type { VaultRegistry } from '../config/registry.js';
import { SecurityError } from '../security/path-security.js';
import type { FilesystemService } from './filesystem-service.js';
import {
  ProjectMappingService,
  resolveSemanticPath,
} from './project-mapping-service.js';
import matter from 'gray-matter';

export interface ProjectContextNote {
  role: string;
  path: string;
  exists: boolean;
  content?: string;
  contentHash?: string;
  truncated?: boolean;
  metadata?: Record<string, unknown>;
  verification?: { stale: boolean; gaps: string[] };
}

export interface ProjectContext {
  vault: string;
  notes: ProjectContextNote[];
  missing: string[];
  indexManifest: Record<string, string>;
  indexAliases: Record<string, string>;
  verificationGaps: Array<{ role: string; path: string; reason: string }>;
}

export interface ProjectTask {
  completed: boolean;
  text: string;
  source: string;
}

export interface ProjectActivityEntry {
  source: string;
  content: string;
}

export interface ProjectActivity {
  vault: string;
  tasks: ProjectTask[];
  decisions: ProjectActivityEntry[];
  risks: ProjectActivityEntry[];
  changelog: ProjectActivityEntry[];
  dailyNotes: ProjectActivityEntry[];
}

function isMissing(error: unknown): boolean {
  return (
    (error instanceof SecurityError && error.code === 'NOT_FOUND') ||
    (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
  );
}

function boundedContent(
  content: string,
  remaining: number,
): {
  content: string;
  truncated: boolean;
} {
  if (content.length <= remaining) return { content, truncated: false };
  return {
    content: `${content.slice(0, Math.max(0, remaining))}\n[content truncated]`,
    truncated: true,
  };
}

function entriesFromNote(
  source: string,
  content: string,
): ProjectActivityEntry[] {
  return content
    .split(/\n(?=##\s)/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ({ source, content: entry }));
}

function parseMetadata(content: string): Record<string, unknown> {
  const parsed = matter(content).data;
  return Object.fromEntries(Object.entries(parsed));
}

export class ProjectContextService {
  private readonly mapping: ProjectMappingService;

  constructor(
    private readonly registry: VaultRegistry,
    private readonly files: FilesystemService,
    mapping?: ProjectMappingService,
  ) {
    this.mapping = mapping ?? new ProjectMappingService(registry, files);
  }

  async getContext(
    vaultName: string,
    maxChars = 30000,
  ): Promise<ProjectContext> {
    const resolved = await this.mapping.resolveIndex(vaultName);
    const indexManifest = resolved.roles;
    let remaining = Math.max(1000, Math.min(maxChars, 100000));
    const notes: ProjectContextNote[] = [];
    const missing: string[] = [];
    const verificationGaps: ProjectContext['verificationGaps'] = [];
    const config = this.registry.get(vaultName).codebaseIndex;
    try {
      await this.files.readNote(vaultName, config.manifest);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (Object.keys(config.roles).length === 0) {
        verificationGaps.push({
          role: 'manifest',
          path: config.manifest,
          reason: 'missing_manifest',
        });
      }
    }
    for (const [role, relativePath] of Object.entries(indexManifest)) {
      try {
        const note = await this.files.readNote(vaultName, relativePath);
        const bounded = boundedContent(note.content, remaining);
        remaining = Math.max(0, remaining - bounded.content.length);
        const metadata = parseMetadata(note.content);
        const verified =
          typeof metadata.last_verified === 'string'
            ? Date.parse(metadata.last_verified)
            : NaN;
        const stale =
          !Number.isFinite(verified) ||
          Date.now() - verified > config.maxAgeDays * 86400000;
        const gaps = metadata.related_paths ? [] : ['related_paths'];
        notes.push({
          role,
          path: note.path,
          exists: true,
          content: bounded.content,
          contentHash: note.contentHash,
          truncated: bounded.truncated,
          metadata,
          verification: { stale, gaps },
        });
        if (stale)
          verificationGaps.push({
            role,
            path: relativePath,
            reason: 'stale_verification',
          });
        for (const gap of gaps)
          verificationGaps.push({
            role,
            path: relativePath,
            reason: `missing_${gap}`,
          });
      } catch (error) {
        if (!isMissing(error)) throw error;
        missing.push(relativePath);
        notes.push({ role, path: relativePath, exists: false });
        verificationGaps.push({
          role,
          path: relativePath,
          reason: 'missing_note',
        });
      }
    }
    return {
      vault: vaultName,
      notes,
      missing,
      indexManifest,
      indexAliases: resolved.aliases,
      verificationGaps,
    };
  }

  async getActivity(
    vaultName: string,
    dailyLimit = 10,
    maxChars = 20000,
  ): Promise<ProjectActivity> {
    const vault = this.registry.get(vaultName);
    const dailyDirectory = vault.dailyNotes.directory;
    const resolved = await this.mapping.resolveIndex(vaultName);
    const indexManifest = resolved.roles;
    const indexAliases = resolved.aliases;
    const activity: ProjectActivity = {
      vault: vaultName,
      tasks: [],
      decisions: [],
      risks: [],
      changelog: [],
      dailyNotes: [],
    };
    const readOptional = async (
      relativePath: string,
    ): Promise<string | undefined> => {
      try {
        return (await this.files.readNote(vaultName, relativePath)).content;
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    };

    const taskPath = resolveSemanticPath(
      indexManifest,
      indexAliases,
      'tasks',
      '06 - Tasks.md',
    );
    const taskContent = await readOptional(taskPath);
    if (taskContent) {
      for (const match of taskContent.matchAll(
        /^\s*-\s*\[([ xX])\]\s+(.+)$/gmu,
      )) {
        const text = match[2]?.trim();
        if (text) {
          activity.tasks.push({
            completed: match[1]?.toLowerCase() === 'x',
            text,
            source: taskPath,
          });
        }
      }
    }

    for (const [key, target] of [
      [
        'decisions',
        resolveSemanticPath(
          indexManifest,
          indexAliases,
          'decisions',
          '04 - Decisions.md',
        ),
      ],
      [
        'risks',
        resolveSemanticPath(
          indexManifest,
          indexAliases,
          'risks',
          '10 - Risks & Issues.md',
        ),
      ],
      [
        'changelog',
        resolveSemanticPath(
          indexManifest,
          indexAliases,
          'changelog',
          '11 - Changelog.md',
        ),
      ],
    ] as const) {
      const content = await readOptional(target);
      if (!content) continue;
      activity[key] = entriesFromNote(target, content);
    }

    const dailyNotes = await this.files
      .listNotes(vaultName, dailyDirectory)
      .catch((error: unknown) => {
        if (isMissing(error)) return [];
        throw error;
      });
    for (const note of dailyNotes
      .sort((a, b) => b.path.localeCompare(a.path))
      .slice(0, Math.max(1, Math.min(dailyLimit, 30)))) {
      const content = await this.files.readNote(vaultName, note.path);
      const bounded = boundedContent(content.content, maxChars);
      activity.dailyNotes.push({ source: note.path, content: bounded.content });
    }
    return activity;
  }
}
