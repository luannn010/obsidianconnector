import type { VaultRegistry } from '../config/registry.js';
import { SecurityError } from '../security/path-security.js';
import type { FilesystemService } from './filesystem-service.js';

const contextNotes = [
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
}

export interface ProjectContext {
  vault: string;
  notes: ProjectContextNote[];
  missing: string[];
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

export class ProjectContextService {
  constructor(
    private readonly registry: VaultRegistry,
    private readonly files: FilesystemService,
  ) {}

  async getContext(
    vaultName: string,
    maxChars = 30000,
  ): Promise<ProjectContext> {
    this.registry.get(vaultName);
    let remaining = Math.max(1000, Math.min(maxChars, 100000));
    const notes: ProjectContextNote[] = [];
    const missing: string[] = [];
    for (const [role, relativePath] of contextNotes) {
      try {
        const note = await this.files.readNote(vaultName, relativePath);
        const bounded = boundedContent(note.content, remaining);
        remaining = Math.max(0, remaining - bounded.content.length);
        notes.push({
          role,
          path: note.path,
          exists: true,
          content: bounded.content,
          contentHash: note.contentHash,
          truncated: bounded.truncated,
        });
      } catch (error) {
        if (!isMissing(error)) throw error;
        missing.push(relativePath);
        notes.push({ role, path: relativePath, exists: false });
      }
    }
    return { vault: vaultName, notes, missing };
  }

  async getActivity(
    vaultName: string,
    dailyLimit = 10,
    maxChars = 20000,
  ): Promise<ProjectActivity> {
    this.registry.get(vaultName);
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

    const taskContent = await readOptional('06 - Tasks.md');
    if (taskContent) {
      for (const match of taskContent.matchAll(
        /^\s*-\s*\[([ xX])\]\s+(.+)$/gmu,
      )) {
        const text = match[2]?.trim();
        if (text) {
          activity.tasks.push({
            completed: match[1]?.toLowerCase() === 'x',
            text,
            source: '06 - Tasks.md',
          });
        }
      }
    }

    for (const [key, target] of [
      ['decisions', '04 - Decisions.md'],
      ['risks', '10 - Risks & Issues.md'],
      ['changelog', '11 - Changelog.md'],
    ] as const) {
      const content = await readOptional(target);
      if (!content) continue;
      activity[key] = entriesFromNote(target, content);
    }

    const dailyNotes = await this.files
      .listNotes(vaultName, 'Daily')
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
