// Vault access for cards and project info. Pure parsing lives in model.ts.

import * as path from 'path';
import {
  FileSystemAdapter,
  TFile,
  getFrontMatterInfo,
  normalizePath,
  type App,
} from 'obsidian';
import {
  CARDS_DIR,
  PROJECT_FILE,
  parseCard,
  parseProjectInfo,
  type Card,
  type CardStatus,
  type ProjectInfo,
} from './model';
import type { ProjectBoardSettings } from './settings';

export function collectCards(app: App): Card[] {
  const cards: Card[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(`${CARDS_DIR}/`)) continue;
    const card = parseCard(
      file.path,
      app.metadataCache.getFileCache(file)?.frontmatter,
    );
    if (card) cards.push(card);
  }
  return cards;
}

export function findCard(app: App, filePath: string): Card | null {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return null;
  return parseCard(
    file.path,
    app.metadataCache.getFileCache(file)?.frontmatter,
  );
}

/** The card owning a file anywhere inside `Board/Cards/<slug>/`. */
export function cardForFile(app: App, file: TFile | null): Card | null {
  if (!file) return null;
  const match = /^Board\/Cards\/([^/]+)\//.exec(file.path);
  return match ? findCard(app, `${CARDS_DIR}/${match[1]}/card.md`) : null;
}

export function cardFile(app: App, card: Card): TFile {
  const file = app.vault.getAbstractFileByPath(card.filePath);
  if (!(file instanceof TFile))
    throw new Error(`Card note not found: ${card.filePath}`);
  return file;
}

export async function updateCard(
  app: App,
  card: Card,
  update: (frontmatter: Record<string, unknown>) => void,
): Promise<void> {
  await app.fileManager.processFrontMatter(cardFile(app, card), update);
}

export async function setCardStatus(
  app: App,
  card: Card,
  status: CardStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await updateCard(app, card, (frontmatter) => {
    frontmatter.status = status;
    Object.assign(frontmatter, extra);
  });
}

export async function readCardBody(app: App, card: Card): Promise<string> {
  const content = await app.vault.cachedRead(cardFile(app, card));
  return content.slice(getFrontMatterInfo(content).contentStart);
}

export async function readIfExists(
  app: App,
  vaultPath: string,
): Promise<string | null> {
  const normalized = normalizePath(vaultPath);
  if (!(await app.vault.adapter.exists(normalized))) return null;
  return app.vault.adapter.read(normalized);
}

export async function writeVaultFile(
  app: App,
  vaultPath: string,
  content: string,
): Promise<void> {
  const normalized = normalizePath(vaultPath);
  const folder = normalized.slice(0, normalized.lastIndexOf('/'));
  if (folder && !(await app.vault.adapter.exists(folder)))
    await app.vault.adapter.mkdir(folder);
  await app.vault.adapter.write(normalized, content);
}

export function vaultBasePath(app: App): string {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter))
    throw new Error('Project Board needs a desktop vault on disk.');
  return adapter.getBasePath();
}

export function absolutePath(app: App, vaultPath: string): string {
  return path.join(vaultBasePath(app), ...normalizePath(vaultPath).split('/'));
}

/** Project info from `Board/.project.json`, with the settings override applied. */
export async function loadProjectInfo(
  app: App,
  settings: ProjectBoardSettings,
): Promise<ProjectInfo> {
  const text = await readIfExists(app, PROJECT_FILE);
  const info = (text && parseProjectInfo(text)) || {
    projectKey: '',
    repoPath: '',
  };
  return {
    projectKey: info.projectKey,
    repoPath: settings.repoPathOverride.trim() || info.repoPath,
  };
}
