import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { VaultRegistry } from '../config/registry.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import { resolveVaultPath } from '../security/path-security.js';
import type { FilesystemService } from '../services/filesystem-service.js';
import { IdeaError } from './errors.js';
import {
  BOARD_DIRECTORY,
  CARDS_DIRECTORY,
  type ArtifactType,
  type CardArtifact,
  type CardContent,
  type CardFrontmatter,
  type CardStatus,
  artifactFileName,
  assertBranchName,
  assertCardSlug,
  cardDirectory,
  cardKnowledgeBody,
  cardNotePath,
  renderCardNote,
  slugify,
  uniqueSlug,
  upsertArtifact,
} from './idea-cards.js';
import {
  IDEAS_NOTE,
  type IdeaEntry,
  type TriagedLink,
  markIdeasTriaged,
  parseIdeas,
} from './ideas-inbox.js';

export const MAX_PROTOTYPE_BYTES = 2 * 1024 * 1024;

export interface IdeaProject {
  vaultName: string;
  repositoryPath?: string;
}

export interface IdeaProjectResolver {
  resolve(projectKey: string): Promise<IdeaProject>;
}

interface ProjectQueryable {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

export class PgIdeaProjectResolver implements IdeaProjectResolver {
  constructor(private readonly pool: ProjectQueryable) {}

  async resolve(projectKey: string): Promise<IdeaProject> {
    const row = (
      await this.pool.query<{ vault_name: string; root_path: string | null }>(
        `SELECT project.vault_name, repository.root_path
         FROM project_knowledge.projects project
         LEFT JOIN project_knowledge.repositories repository
           ON repository.project_id=project.project_id
         WHERE project.project_key=$1
         ORDER BY repository.name NULLS LAST LIMIT 1`,
        [projectKey],
      )
    ).rows[0];
    if (!row) throw new IdeaError(`Project is not registered: ${projectKey}`);
    return {
      vaultName: row.vault_name,
      ...(row.root_path ? { repositoryPath: row.root_path } : {}),
    };
  }
}

export interface CreateIdeaCardInput extends CardContent {
  ideaRefs: string[];
}

export interface IdeaCardSummary {
  slug: string;
  path: string;
  title: string;
  status: CardStatus;
}

interface StoredCard {
  slug: string;
  frontmatter: CardFrontmatter;
  body: string;
  contentHash: string;
}

const ideasStarter = `---\ntype: ideas\n---\n\n# Ideas\n\nOne "- " bullet per idea. Ask Claude or Codex to "triage my ideas" to turn them into board cards.\n\n`;
const boardStarter = `---\nboard: ideas\n---\n\n# Board\n\nOpen this note with the Project Board plugin to see the cards in Board/Cards.\n`;
const galleryStarter = `---\nboard: prototypes\n---\n\n# Prototypes\n\nOpen this note with the Project Board plugin to browse every card's prototypes.\n`;

export class IdeaWorkspace {
  constructor(
    private readonly registry: VaultRegistry,
    private readonly files: FilesystemService,
    private readonly projects: IdeaProjectResolver,
    private readonly knowledge?: KnowledgeStore,
  ) {}

  async listIdeas(input: { projectKey: string }): Promise<{
    projectKey: string;
    vault: string;
    ideasPath: string;
    ideas: IdeaEntry[];
  }> {
    const { vaultName } = await this.projects.resolve(input.projectKey);
    const content = await this.readIdeas(vaultName);
    return {
      projectKey: input.projectKey,
      vault: vaultName,
      ideasPath: IDEAS_NOTE,
      ideas: parseIdeas(content),
    };
  }

  async createCards(input: {
    projectKey: string;
    idempotencyKey: string;
    actor?: string;
    cards: CreateIdeaCardInput[];
  }): Promise<{
    projectKey: string;
    cards: Array<IdeaCardSummary & { outcome: 'created' | 'existing' }>;
    triagedIdeas: string[];
    warnings: string[];
  }> {
    const { vaultName } = await this.projects.resolve(input.projectKey);
    const ideasContent = await this.readIdeas(vaultName);
    const pending = new Set(parseIdeas(ideasContent).map((idea) => idea.ref));
    const existing = await this.readCards(vaultName);
    const taken = new Set(existing.map((card) => card.slug));
    const links = new Map<string, TriagedLink>();
    const results: Array<
      IdeaCardSummary & { outcome: 'created' | 'existing' }
    > = [];
    const warnings: string[] = [];
    const created = new Date().toISOString();

    for (const card of input.cards) {
      const refs = [...new Set(card.ideaRefs)];
      const primaryRef = refs[0];
      if (!primaryRef)
        throw new IdeaError('Each card needs at least one idea ref');
      const replay = existing.find(
        (stored) =>
          stored.frontmatter.idea_ref === primaryRef &&
          slugify(stored.frontmatter.title) === slugify(card.title),
      );
      if (replay) {
        results.push({ ...summary(replay), outcome: 'existing' });
        continue;
      }
      const unknown = refs.filter((ref) => !pending.has(ref));
      if (unknown.length)
        throw new IdeaError(
          `Unknown or already triaged idea refs: ${unknown.join(', ')}`,
        );
      const slug = uniqueSlug(card.title, taken);
      taken.add(slug);
      const rendered = renderCardNote(
        input.projectKey,
        primaryRef,
        card,
        created,
      );
      const knowledgeId = await this.recordCard(input, slug, card, warnings);
      rendered.frontmatter.knowledge_id = knowledgeId;
      const markdown = knowledgeId
        ? matter.stringify(
            matter(rendered.markdown).content,
            rendered.frontmatter as unknown as object,
          )
        : rendered.markdown;
      await this.files.createNote(vaultName, cardNotePath(slug), markdown);
      for (const ref of refs)
        if (!links.has(ref)) links.set(ref, { slug, title: card.title });
      results.push({
        slug,
        path: cardNotePath(slug),
        title: card.title,
        status: 'backlog',
        outcome: 'created',
      });
    }

    let triagedIdeas: string[] = [];
    if (links.size) {
      const note = await this.files.readNote(vaultName, IDEAS_NOTE);
      const marked = markIdeasTriaged(note.content, links);
      triagedIdeas = marked.marked;
      if (marked.content !== note.content)
        await this.files.updateNote(
          vaultName,
          IDEAS_NOTE,
          marked.content,
          note.contentHash,
        );
    }
    return {
      projectKey: input.projectKey,
      cards: results,
      triagedIdeas,
      warnings,
    };
  }

  async attachArtifact(input: {
    projectKey: string;
    slug: string;
    type: ArtifactType;
    title: string;
    content?: string;
    branch?: string;
    diagramFormat?: 'mermaid' | 'svg';
  }): Promise<{
    projectKey: string;
    slug: string;
    artifact: CardArtifact;
    artifacts: CardArtifact[];
  }> {
    const { vaultName } = await this.projects.resolve(input.projectKey);
    const card = await this.readCard(vaultName, input.slug);
    let artifact: CardArtifact;
    const updates: Partial<CardFrontmatter> = {};
    if (input.type === 'spike') {
      if (!input.branch) throw new IdeaError('Spike artifacts need a branch');
      const branch = assertBranchName(input.branch);
      artifact = { type: 'spike', title: input.title, branch };
      updates.spike_branch = branch;
    } else {
      if (input.content === undefined || input.content.trim() === '')
        throw new IdeaError(`${input.type} artifacts need content`);
      if (Buffer.byteLength(input.content, 'utf8') > MAX_PROTOTYPE_BYTES)
        throw new IdeaError('Artifact content exceeds the 2 MB limit');
      const relative = artifactFileName(
        input.type,
        input.title,
        input.diagramFormat,
      );
      if (input.type === 'plan')
        await this.files.createNote(
          vaultName,
          `${cardDirectory(card.slug)}/${relative}`,
          input.content,
          true,
        );
      else
        await this.writeCardAsset(
          vaultName,
          card.slug,
          relative,
          input.content,
        );
      artifact = { type: input.type, title: input.title, path: relative };
    }
    const artifacts = upsertArtifact(
      card.frontmatter.artifacts ?? [],
      artifact,
    );
    await this.writeCard(vaultName, card, { ...updates, artifacts });
    return {
      projectKey: input.projectKey,
      slug: card.slug,
      artifact,
      artifacts,
    };
  }

  async setStatus(input: {
    projectKey: string;
    slug: string;
    status: CardStatus;
    note?: string;
    actor?: string;
  }): Promise<{
    projectKey: string;
    slug: string;
    from: CardStatus;
    to: CardStatus;
    warnings: string[];
  }> {
    const { vaultName } = await this.projects.resolve(input.projectKey);
    const card = await this.readCard(vaultName, input.slug);
    const from = card.frontmatter.status;
    const updates: Partial<CardFrontmatter> = { status: input.status };
    if (input.note !== undefined) updates.review_note = input.note;
    else if (input.status === 'ready') updates.review_note = null;
    await this.writeCard(vaultName, card, updates);
    const warnings: string[] = [];
    if (
      this.knowledge &&
      card.frontmatter.knowledge_id &&
      from !== input.status
    ) {
      try {
        await this.knowledge.writeProjectKnowledge({
          projectKey: input.projectKey,
          actor: input.actor ?? 'obsidian-board',
          message: `Card ${card.slug}: ${from} -> ${input.status}`,
          reason: 'status_change',
          idempotencyKey: `idea-card:${card.slug}:status:${input.status}:${card.contentHash.slice(0, 12)}`,
          changes: [
            {
              operation: 'patch',
              item: {
                id: card.frontmatter.knowledge_id,
                deliveryStatus: input.status,
              },
            },
          ],
        });
      } catch (error) {
        warnings.push(knowledgeWarning(error));
      }
    }
    return {
      projectKey: input.projectKey,
      slug: card.slug,
      from,
      to: input.status,
      warnings,
    };
  }

  private async recordCard(
    input: { projectKey: string; idempotencyKey: string; actor?: string },
    slug: string,
    card: CardContent,
    warnings: string[],
  ): Promise<string | null> {
    if (!this.knowledge) return null;
    try {
      const result = await this.knowledge.writeProjectKnowledge({
        projectKey: input.projectKey,
        actor: input.actor ?? 'obsidian-board',
        message: `Triage idea into card ${slug}`,
        reason: 'progress',
        idempotencyKey: `${input.idempotencyKey}:${slug}`,
        changes: [
          {
            operation: 'create',
            item: {
              stableKey: `idea-card:${slug}`,
              kind: 'work_item',
              title: card.title,
              bodyMarkdown: cardKnowledgeBody(card),
              deliveryStatus: 'backlog',
              properties: { card: cardNotePath(slug), source: 'ideas' },
            },
          },
        ],
      });
      return result.changes[0]?.itemId ?? null;
    } catch (error) {
      warnings.push(knowledgeWarning(error));
      return null;
    }
  }

  private async readIdeas(vaultName: string): Promise<string> {
    try {
      return (await this.files.readNote(vaultName, IDEAS_NOTE)).content;
    } catch (error) {
      if (isMissing(error)) return '';
      throw error;
    }
  }

  private async readCards(vaultName: string): Promise<StoredCard[]> {
    let entries;
    try {
      entries = await this.files.listDirectory(vaultName, CARDS_DIRECTORY);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const cards: StoredCard[] = [];
    for (const entry of entries) {
      if (entry.type !== 'directory') continue;
      const slug = path.posix.basename(entry.path);
      try {
        cards.push(await this.readCard(vaultName, slug));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return cards;
  }

  private async readCard(vaultName: string, slug: string): Promise<StoredCard> {
    const note = await this.files.readNote(
      vaultName,
      cardNotePath(assertCardSlug(slug)),
    );
    const parsed = matter(note.content);
    const frontmatter = parsed.data as CardFrontmatter;
    if (frontmatter.card !== true)
      throw new IdeaError(`Note is not an idea card: ${cardNotePath(slug)}`);
    return {
      slug,
      frontmatter,
      body: parsed.content,
      contentHash: note.contentHash,
    };
  }

  private async writeCard(
    vaultName: string,
    card: StoredCard,
    updates: Partial<CardFrontmatter>,
  ): Promise<void> {
    await this.files.updateNote(
      vaultName,
      cardNotePath(card.slug),
      matter.stringify(card.body, { ...card.frontmatter, ...updates }),
      card.contentHash,
    );
  }

  private async writeCardAsset(
    vaultName: string,
    slug: string,
    relative: string,
    content: string,
  ): Promise<void> {
    const vault = this.registry.get(vaultName);
    if (vault.readOnly)
      throw new IdeaError(`Vault is read-only: ${vault.name}`);
    const directory = await resolveVaultPath(
      vault.path,
      `${cardDirectory(slug)}/${path.posix.dirname(relative)}`,
      { kind: 'directory', allowMissing: true },
    );
    await mkdir(directory, { recursive: true });
    await atomicWrite(
      path.join(directory, path.posix.basename(relative)),
      content,
    );
  }
}

/** Create Ideas.md, the board and gallery notes, and the plugin's project file. */
export async function scaffoldIdeaWorkspace(
  registry: VaultRegistry,
  files: FilesystemService,
  vaultName: string,
  project: { projectKey: string; repositoryPath: string },
): Promise<{ created: string[]; preserved: string[] }> {
  const created: string[] = [];
  const preserved: string[] = [];
  for (const [relativePath, content] of [
    [IDEAS_NOTE, ideasStarter],
    [`${BOARD_DIRECTORY}/Board.md`, boardStarter],
    [`${BOARD_DIRECTORY}/Prototypes.md`, galleryStarter],
  ] as const) {
    try {
      await files.createNote(vaultName, relativePath, content);
      created.push(relativePath);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Note already exists:')
      ) {
        preserved.push(relativePath);
        continue;
      }
      throw error;
    }
  }
  const vault = registry.get(vaultName);
  const board = await resolveVaultPath(vault.path, BOARD_DIRECTORY, {
    kind: 'directory',
    allowMissing: true,
  });
  await mkdir(board, { recursive: true });
  await atomicWrite(
    path.join(board, '.project.json'),
    `${JSON.stringify({ projectKey: project.projectKey, repoPath: project.repositoryPath }, null, 2)}\n`,
  );
  return { created, preserved };
}

function summary(card: StoredCard): IdeaCardSummary {
  return {
    slug: card.slug,
    path: cardNotePath(card.slug),
    title: card.frontmatter.title,
    status: card.frontmatter.status,
  };
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code ?? '';
  return code === 'ENOENT' || code === 'NOT_FOUND';
}

function knowledgeWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Card saved in the vault, but project knowledge was not updated: ${message}`;
}

async function atomicWrite(absolute: string, content: string): Promise<void> {
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, 'utf8');
  try {
    await rename(temporary, absolute);
  } catch {
    await rm(temporary, { force: true });
    throw new Error('Atomic replacement was unavailable');
  }
}
