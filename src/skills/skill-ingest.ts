import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { KnowledgeChange } from '../knowledge/types.js';

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const allowedOwners = new Set(['claude', 'codex', 'both', 'either']);
const skillPathPattern = /^skills\/([^/]+)\/([^/]+)\/SKILL\.md$/u;
const referencePathPattern =
  /^skills\/([^/]+)\/([^/]+)\/references\/([^/]+)\.md$/u;

export interface SkillRepositoryFile {
  relativePath: string;
  text: string;
}

export interface SkillKnowledgeItem {
  kind: 'other:skill' | 'other:skill-reference';
  stableKey: string;
  title: string;
  bodyMarkdown: string;
  domain: string;
  properties: Record<string, unknown> & { contentHash: string };
}

export interface ExistingSkillKnowledgeItem {
  id: string;
  stableKey: string;
  kind: 'other:skill' | 'other:skill-reference';
  currentVersion: number;
  contentHash?: string;
  deliveryStatus: string | null;
  supersededBy: string | null;
}

export interface SkillIngestSummary {
  created: number;
  updated: number;
  unchanged: number;
  superseded: number;
}

export interface SkillChangePlan {
  changes: KnowledgeChange[];
  summary: SkillIngestSummary;
}

export interface PreparedSkillChangeBatch {
  changes: KnowledgeChange[];
  hash: string;
}

export class SkillIngestValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join('\n'));
    this.name = 'SkillIngestValidationError';
    this.errors = errors;
  }
}

export function stripDomainPrefix(folderName: string): string {
  return folderName.replace(/^\d+-/u, '');
}

export function normalizeSkillText(text: string): string {
  return text.replace(/\r\n/gu, '\n');
}

export function contentHash(text: string): string {
  return createHash('sha256').update(normalizeSkillText(text)).digest('hex');
}

function forwardSlashPath(relativePath: string): string {
  return relativePath.replace(/\\/gu, '/');
}

function jsonCompatibleValue(
  value: unknown,
  ancestors = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new Error('numbers must be finite');
  }
  if (typeof value !== 'object')
    throw new Error(`unsupported ${typeof value} value`);
  if (ancestors.has(value)) throw new Error('cyclic aliases are not supported');
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.map((entry) => jsonCompatibleValue(entry, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error('only plain objects and arrays are supported');
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        jsonCompatibleValue(entry, ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function yamlFrontmatter(
  text: string,
  relativePath: string,
): ReturnType<typeof matter> {
  const normalized = normalizeSkillText(text);
  const openingLine = normalized.slice(0, normalized.indexOf('\n')).trimEnd();
  if (openingLine !== '---')
    throw new Error('only YAML frontmatter is supported');
  return matter(normalized, {
    engines: {
      javascript: {
        parse: () => {
          throw new Error(
            `${relativePath}: executable frontmatter is not supported`,
          );
        },
      },
    },
  });
}

function knowledgeItem(change: SkillKnowledgeItem): KnowledgeChange['item'] {
  return {
    kind: change.kind,
    stableKey: change.stableKey,
    title: change.title,
    bodyMarkdown: change.bodyMarkdown,
    domain: change.domain,
    properties: change.properties,
  };
}

export function buildSkillKnowledgeItems(
  repositoryFiles: SkillRepositoryFile[],
  gitCommit: string,
): SkillKnowledgeItem[] {
  const files = repositoryFiles
    .map((file) => ({
      relativePath: forwardSlashPath(file.relativePath),
      text: file.text,
    }))
    .sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath, 'en'),
    );
  const errors: string[] = [];
  const skills = new Map<
    string,
    {
      domainFolder: string;
      skillFolder: string;
      relativePath: string;
      text: string;
      data: Record<string, unknown>;
      content: string;
    }
  >();

  for (const file of files) {
    const match = skillPathPattern.exec(file.relativePath);
    if (!match) continue;
    const domainFolder = match[1]!;
    const skillFolder = match[2]!;
    let parsed: ReturnType<typeof matter>;
    try {
      parsed = yamlFrontmatter(file.text, file.relativePath);
    } catch (error) {
      errors.push(
        `${file.relativePath}: invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (
      !parsed.data ||
      typeof parsed.data !== 'object' ||
      Array.isArray(parsed.data)
    ) {
      errors.push(`${file.relativePath}: frontmatter must be a YAML mapping`);
      continue;
    }
    let data: Record<string, unknown>;
    try {
      data = jsonCompatibleValue(parsed.data) as Record<string, unknown>;
    } catch (error) {
      errors.push(
        `${file.relativePath}: frontmatter must contain only JSON-compatible values: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    const description =
      typeof data.description === 'string' ? data.description.trim() : '';
    const owner =
      data.owner === undefined
        ? 'either'
        : typeof data.owner === 'string'
          ? data.owner.trim()
          : '';

    if (!name)
      errors.push(`${file.relativePath}: name must be a non-empty string`);
    else {
      if (name !== skillFolder)
        errors.push(
          `${file.relativePath}: name "${name}" must equal folder name "${skillFolder}"`,
        );
      if (!skillNamePattern.test(name))
        errors.push(
          `${file.relativePath}: name "${name}" must match ${skillNamePattern.source}`,
        );
    }
    if (!description)
      errors.push(
        `${file.relativePath}: description must be a non-empty string`,
      );
    if (!allowedOwners.has(owner))
      errors.push(
        `${file.relativePath}: owner must be one of claude, codex, both, either`,
      );

    if (name) {
      const duplicate = skills.get(name);
      if (duplicate)
        errors.push(
          `Duplicate skill name "${name}" in ${duplicate.relativePath} and ${file.relativePath}`,
        );
      else
        skills.set(name, {
          domainFolder,
          skillFolder,
          relativePath: file.relativePath,
          text: file.text,
          data: { ...data, name, description, owner },
          content: parsed.content,
        });
    }
  }

  if (errors.length) throw new SkillIngestValidationError(errors);

  const items: SkillKnowledgeItem[] = [];
  for (const [name, skill] of [...skills.entries()].sort(([left], [right]) =>
    left.localeCompare(right, 'en'),
  )) {
    const description = String(skill.data.description);
    const body = normalizeSkillText(skill.content).trim();
    items.push({
      kind: 'other:skill',
      stableKey: `skill:${name}`,
      title: name,
      bodyMarkdown: [description, body].filter(Boolean).join('\n\n'),
      domain: stripDomainPrefix(skill.domainFolder),
      properties: {
        ...skill.data,
        path: skill.relativePath,
        gitCommit,
        contentHash: contentHash(skill.text),
      },
    });

    const referencePrefix = `skills/${skill.domainFolder}/${skill.skillFolder}/references/`;
    for (const reference of files.filter((file) =>
      file.relativePath.startsWith(referencePrefix),
    )) {
      const match = referencePathPattern.exec(reference.relativePath);
      if (!match) continue;
      const referenceName = match[3]!;
      items.push({
        kind: 'other:skill-reference',
        stableKey: `skill:${name}:ref:${referenceName}`,
        title: `${name}/${referenceName}`,
        bodyMarkdown: normalizeSkillText(reference.text).trim(),
        domain: stripDomainPrefix(skill.domainFolder),
        properties: {
          skill: name,
          path: reference.relativePath,
          gitCommit,
          contentHash: contentHash(reference.text),
        },
      });
    }
  }

  return items.sort((left, right) =>
    left.stableKey.localeCompare(right.stableKey, 'en'),
  );
}

export function planSkillChanges(
  candidates: SkillKnowledgeItem[],
  existingItems: ExistingSkillKnowledgeItem[],
): SkillChangePlan {
  const changes: KnowledgeChange[] = [];
  const summary: SkillIngestSummary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    superseded: 0,
  };
  const existingByStableKey = new Map(
    existingItems.map((item) => [item.stableKey, item]),
  );
  const candidateKeys = new Set<string>();

  for (const candidate of [...candidates].sort((left, right) =>
    left.stableKey.localeCompare(right.stableKey, 'en'),
  )) {
    candidateKeys.add(candidate.stableKey);
    const existing = existingByStableKey.get(candidate.stableKey);
    if (!existing) {
      changes.push({ operation: 'create', item: knowledgeItem(candidate) });
      summary.created++;
    } else if (
      existing.contentHash === candidate.properties.contentHash &&
      existing.deliveryStatus !== 'retired'
    ) {
      summary.unchanged++;
    } else {
      const sameContent =
        existing.contentHash === candidate.properties.contentHash;
      changes.push({
        operation: 'patch',
        expectedVersion: existing.currentVersion,
        item: {
          id: existing.id,
          ...(sameContent ? {} : knowledgeItem(candidate)),
          ...(existing.deliveryStatus === 'retired'
            ? { deliveryStatus: 'active' }
            : {}),
        },
      });
      summary.updated++;
    }
  }

  for (const existing of [...existingItems].sort((left, right) =>
    left.stableKey.localeCompare(right.stableKey, 'en'),
  )) {
    if (candidateKeys.has(existing.stableKey)) continue;
    if (existing.supersededBy || existing.deliveryStatus === 'retired') {
      summary.unchanged++;
      continue;
    }
    changes.push({
      operation: 'patch',
      expectedVersion: existing.currentVersion,
      item: { id: existing.id, deliveryStatus: 'retired' },
    });
    summary.superseded++;
  }

  return { changes, summary };
}

export function batchSkillChanges(
  changes: KnowledgeChange[],
  batchSize = 20,
): KnowledgeChange[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20)
    throw new Error('Skill ingest batch size must be an integer from 1 to 20');
  const batches: KnowledgeChange[][] = [];
  for (let index = 0; index < changes.length; index += batchSize)
    batches.push(changes.slice(index, index + batchSize));
  return batches;
}

export function hashSkillChangeBatch(changes: KnowledgeChange[]): string {
  return createHash('sha256').update(JSON.stringify(changes)).digest('hex');
}

export function prepareSkillChangeBatches(
  changes: KnowledgeChange[],
): PreparedSkillChangeBatch[] {
  return batchSkillChanges(changes).map((batch) => ({
    changes: batch,
    hash: hashSkillChangeBatch(batch),
  }));
}

export async function readSkillRepository(
  repositoryPath: string,
): Promise<SkillRepositoryFile[]> {
  const skillsRoot = path.join(repositoryPath, 'skills');
  const files: SkillRepositoryFile[] = [];
  const domains = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));

  for (const domain of domains) {
    const domainPath = path.join(skillsRoot, domain.name);
    const skillDirectories = (
      await readdir(domainPath, { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const skillDirectory of skillDirectories) {
      const skillRoot = path.join(domainPath, skillDirectory.name);
      const skillPath = path.join(skillRoot, 'SKILL.md');
      try {
        files.push({
          relativePath: forwardSlashPath(
            path.relative(repositoryPath, skillPath),
          ),
          text: await readFile(skillPath, 'utf8'),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }

      const referencesPath = path.join(skillRoot, 'references');
      let references;
      try {
        references = await readdir(referencesPath, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const reference of references
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
        const referencePath = path.join(referencesPath, reference.name);
        files.push({
          relativePath: forwardSlashPath(
            path.relative(repositoryPath, referencePath),
          ),
          text: await readFile(referencePath, 'utf8'),
        });
      }
    }
  }

  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, 'en'),
  );
}
