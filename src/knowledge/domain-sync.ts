import { z } from 'zod';

export type DomainFreshness =
  | 'current'
  | 'stale'
  | 'possibly_stale'
  | 'unverified'
  | 'missing';

export interface DomainPathRule {
  domain: string;
  pattern: string;
  exclusions?: string[];
}

export interface DomainEvidenceLink {
  domain: string;
  path: string;
  ref: string;
}

export interface DomainProjectionInput {
  domain: string;
  notePath: string;
  projectionRevision?: number;
  lastSyncedCommit?: string;
  lastSyncedDirtyHash?: string;
  evidenceState?: DomainFreshness;
}

export interface DomainAuditInput {
  currentCommit: string;
  currentDirtyHash?: string;
  indexedCommit?: string;
  indexedDirtyHash?: string;
  databaseRevision: number;
  changedPaths: string[];
  rules: DomainPathRule[];
  evidence: DomainEvidenceLink[];
  projections: DomainProjectionInput[];
  comparisonComplete: boolean;
}

export interface DomainAuditResult {
  domains: Array<{
    name: string;
    notePath: string;
    state: DomainFreshness;
    lastSyncedCommit?: string;
    lastSyncedDirtyHash?: string;
    currentCommit: string;
    currentDirtyHash?: string;
    databaseRevision: number;
    projectionRevision?: number;
    reasons: string[];
    changedPaths: string[];
    evidenceRefs: string[];
  }>;
  unmappedChanges: string[];
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function globPattern(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let expression = '^';
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index]!;
    if (character === '*') {
      if (normalized[index + 1] === '*') {
        expression += '.*';
        index++;
      } else expression += '[^/]*';
      continue;
    }
    if (character === '?') {
      expression += '[^/]';
      continue;
    }
    expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
  }
  return new RegExp(`${expression}$`, 'u');
}

const domainManifestSchema = z.object({
  version: z.literal(1),
  domains: z.record(
    z.string().trim().min(1),
    z.object({
      include: z.array(z.string().trim().min(1)).min(1),
      exclude: z.array(z.string().trim().min(1)).default([]),
    }),
  ),
});

export function parseDomainManifest(content: string): DomainPathRule[] {
  const manifest = domainManifestSchema.parse(JSON.parse(content));
  return Object.entries(manifest.domains)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([domain, definition]) =>
      definition.include.map((pattern) => ({
        domain,
        pattern: normalizePath(pattern),
        ...(definition.exclude.length
          ? { exclusions: definition.exclude.map(normalizePath) }
          : {}),
      })),
    );
}

export function auditDomainSync(input: DomainAuditInput): DomainAuditResult {
  const assignments = new Map<
    string,
    { explicit: Set<string>; inferred: Set<string>; refs: Set<string> }
  >();
  const domainNames = new Set<string>();
  for (const rule of input.rules) domainNames.add(rule.domain);
  for (const link of input.evidence) domainNames.add(link.domain);
  for (const projection of input.projections)
    domainNames.add(projection.domain);

  const compiledRules = input.rules.map((rule) => ({
    ...rule,
    matcher: globPattern(rule.pattern),
    exclusions: (rule.exclusions ?? []).map(globPattern),
  }));
  const normalizedEvidence = input.evidence.map((link) => ({
    ...link,
    path: normalizePath(link.path),
  }));
  const unmappedChanges: string[] = [];

  for (const rawPath of input.changedPaths) {
    const changedPath = normalizePath(rawPath);
    const explicit = new Set(
      compiledRules
        .filter(
          (rule) =>
            rule.matcher.test(changedPath) &&
            !rule.exclusions.some((matcher) => matcher.test(changedPath)),
        )
        .map((rule) => rule.domain),
    );
    const inferredLinks = explicit.size
      ? []
      : normalizedEvidence.filter((link) => link.path === changedPath);
    const inferred = new Set(inferredLinks.map((link) => link.domain));
    if (!explicit.size && !inferred.size) {
      unmappedChanges.push(changedPath);
      continue;
    }
    for (const domain of new Set([...explicit, ...inferred])) {
      const assignment = assignments.get(domain) ?? {
        explicit: new Set<string>(),
        inferred: new Set<string>(),
        refs: new Set<string>(),
      };
      if (explicit.has(domain)) assignment.explicit.add(changedPath);
      if (inferred.has(domain)) assignment.inferred.add(changedPath);
      for (const link of inferredLinks)
        if (link.domain === domain) assignment.refs.add(link.ref);
      assignments.set(domain, assignment);
    }
  }

  const domains = [...domainNames]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const projection = input.projections.find(
        (candidate) => candidate.domain === name,
      );
      const assignment = assignments.get(name);
      const changedPaths = [
        ...(assignment?.explicit ?? []),
        ...(assignment?.inferred ?? []),
      ].sort();
      const reasons: string[] = [];
      let state: DomainFreshness = 'current';
      if (!projection || projection.evidenceState === 'missing') {
        state = 'missing';
        reasons.push(
          projection ? 'Required source evidence is missing' : 'Domain note is missing',
        );
      } else if (
        projection.projectionRevision !== undefined &&
        projection.projectionRevision < input.databaseRevision
      ) {
        state = 'stale';
        reasons.push('Projection revision is behind canonical knowledge');
      } else if (assignment?.explicit.size) {
        state = 'stale';
        reasons.push('Mapped source paths changed');
      } else if (assignment?.inferred.size) {
        state = 'possibly_stale';
        reasons.push('Source paths matched by evidence fallback');
      } else if (projection.evidenceState === 'stale') {
        state = 'stale';
        reasons.push('One or more source evidence hashes changed');
      } else if (projection.evidenceState === 'possibly_stale') {
        state = 'possibly_stale';
        reasons.push('Source evidence requires review');
      } else if (projection.evidenceState === 'unverified') {
        state = 'unverified';
        reasons.push('Domain note has no verified source evidence');
      } else if (!input.comparisonComplete) {
        state = 'possibly_stale';
        reasons.push('Worktree comparison is incomplete');
      }
      return {
        name,
        notePath: projection?.notePath ?? '',
        state,
        ...(projection?.lastSyncedCommit
          ? { lastSyncedCommit: projection.lastSyncedCommit }
          : {}),
        ...(projection?.lastSyncedDirtyHash
          ? { lastSyncedDirtyHash: projection.lastSyncedDirtyHash }
          : {}),
        currentCommit: input.currentCommit,
        ...(input.currentDirtyHash
          ? { currentDirtyHash: input.currentDirtyHash }
          : {}),
        databaseRevision: input.databaseRevision,
        ...(projection?.projectionRevision !== undefined
          ? { projectionRevision: projection.projectionRevision }
          : {}),
        reasons,
        changedPaths,
        evidenceRefs: [
          ...new Set([
            ...(assignment?.refs ?? []),
            ...normalizedEvidence
              .filter((link) => link.domain === name)
              .map((link) => link.ref),
          ]),
        ].sort(),
      };
    });
  return { domains, unmappedChanges: [...new Set(unmappedChanges)].sort() };
}
