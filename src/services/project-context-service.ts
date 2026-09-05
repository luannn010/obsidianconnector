import type { VaultRegistry } from '../config/registry.js';
import type { CodebaseIndexConfig } from '../config/schema.js';
import { SecurityError } from '../security/path-security.js';
import type { FilesystemService } from './filesystem-service.js';
import matter from 'gray-matter';

const legacyContextNotes = [
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

function roleMapFromMetadata(
  metadata: Record<string, unknown>,
): Record<string, string> {
  if (
    metadata.roles &&
    typeof metadata.roles === 'object' &&
    !Array.isArray(metadata.roles)
  ) {
    return Object.fromEntries(
      Object.entries(metadata.roles).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  }
  return {};
}

export class ProjectContextService {
  constructor(
    private readonly registry: VaultRegistry,
    private readonly files: FilesystemService,
  ) {}

  private async resolveIndexManifest(
    vaultName: string,
    config: CodebaseIndexConfig,
    verificationGaps?: ProjectContext['verificationGaps'],
  ): Promise<Record<string, string>> {
    const configuredRoles = config.roles ?? {};
    let manifestRoles: Record<string, string> = {};
    try {
      const manifest = await this.files.readNote(vaultName, config.manifest);
      manifestRoles = roleMapFromMetadata(parseMetadata(manifest.content));
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (Object.keys(configuredRoles).length === 0) {
        verificationGaps?.push({
          role: 'manifest',
          path: config.manifest,
          reason: 'missing_manifest',
        });
      }
    }
    return {
      ...Object.fromEntries(legacyContextNotes),
      ...manifestRoles,
      ...configuredRoles,
    };
  }

  async getContext(
    vaultName: string,
    maxChars = 30000,
  ): Promise<ProjectContext> {
    const config = this.registry.get(vaultName).codebaseIndex;
    let remaining = Math.max(1000, Math.min(maxChars, 100000));
    const notes: ProjectContextNote[] = [];
    const missing: string[] = [];
    const verificationGaps: ProjectContext['verificationGaps'] = [];
    const indexManifest = await this.resolveIndexManifest(
      vaultName,
      config,
      verificationGaps,
    );
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
    const indexManifest = await this.resolveIndexManifest(
      vaultName,
      vault.codebaseIndex,
    );
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

    const taskPath = indexManifest.tasks ?? '06 - Tasks.md';
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
      ['decisions', indexManifest.decisions ?? '04 - Decisions.md'],
      ['risks', indexManifest.risks ?? '10 - Risks & Issues.md'],
      ['changelog', indexManifest.changelog ?? '11 - Changelog.md'],
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
