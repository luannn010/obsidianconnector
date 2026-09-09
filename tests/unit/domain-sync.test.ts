import { describe, expect, it } from 'vitest';
import {
  auditDomainSync,
  parseDomainManifest,
} from '../../src/knowledge/domain-sync.js';

const projections = [
  {
    domain: 'Server control',
    notePath: 'Published/01 - Architecture/Domains/Server control.md',
    projectionRevision: 7,
    lastSyncedCommit: 'base',
    evidenceState: 'current' as const,
  },
  {
    domain: 'Customer provisioning',
    notePath: 'Published/01 - Architecture/Domains/Customer provisioning.md',
    projectionRevision: 7,
    lastSyncedCommit: 'base',
    evidenceState: 'current' as const,
  },
];

describe('domain sync audit', () => {
  it('parses versioned domain manifests and honors exclusions', () => {
    const rules = parseDomainManifest(
      JSON.stringify({
        version: 1,
        domains: {
          'Server control': {
            include: ['services/host-agent/**'],
            exclude: ['services/host-agent/generated/**'],
          },
        },
      }),
    );
    expect(rules).toEqual([
      {
        domain: 'Server control',
        pattern: 'services/host-agent/**',
        exclusions: ['services/host-agent/generated/**'],
      },
    ]);
    const result = auditDomainSync({
      currentCommit: 'head',
      indexedCommit: 'head',
      databaseRevision: 1,
      changedPaths: ['services/host-agent/generated/client.ts'],
      rules,
      evidence: [],
      projections,
      comparisonComplete: true,
    });
    expect(result.unmappedChanges).toEqual([
      'services/host-agent/generated/client.ts',
    ]);
  });

  it('marks only the explicitly owned domain stale across a commit gap', () => {
    const result = auditDomainSync({
      currentCommit: 'head',
      indexedCommit: 'head',
      databaseRevision: 7,
      changedPaths: ['services/host-agent/src/rcon.ts'],
      rules: [
        { domain: 'Server control', pattern: 'services/host-agent/**' },
        { domain: 'Customer provisioning', pattern: 'services/billing/**' },
      ],
      evidence: [],
      projections,
      comparisonComplete: true,
    });

    expect(result.domains).toEqual([
      expect.objectContaining({
        name: 'Customer provisioning',
        state: 'current',
        changedPaths: [],
      }),
      expect.objectContaining({
        name: 'Server control',
        state: 'stale',
        changedPaths: ['services/host-agent/src/rcon.ts'],
        reasons: ['Mapped source paths changed'],
      }),
    ]);
    expect(result.unmappedChanges).toEqual([]);
  });

  it('supports overlapping rules, evidence fallback, and unmapped changes', () => {
    const result = auditDomainSync({
      currentCommit: 'head',
      currentDirtyHash: 'dirty',
      indexedCommit: 'head',
      indexedDirtyHash: 'dirty',
      databaseRevision: 7,
      changedPaths: [
        'packages/shared/src/auth.ts',
        'services/modpacks/src/import.ts',
        'scratch/unknown.txt',
      ],
      rules: [
        { domain: 'Server control', pattern: 'packages/shared/**' },
        { domain: 'Customer provisioning', pattern: 'packages/shared/**' },
      ],
      evidence: [
        {
          domain: 'Server control',
          path: 'services/modpacks/src/import.ts',
          ref: 'knowledge:item-1:v2',
        },
      ],
      projections,
      comparisonComplete: true,
    });

    expect(result.domains).toEqual([
      expect.objectContaining({
        name: 'Customer provisioning',
        state: 'stale',
        changedPaths: ['packages/shared/src/auth.ts'],
      }),
      expect.objectContaining({
        name: 'Server control',
        state: 'stale',
        changedPaths: [
          'packages/shared/src/auth.ts',
          'services/modpacks/src/import.ts',
        ],
        evidenceRefs: ['knowledge:item-1:v2'],
      }),
    ]);
    expect(result.unmappedChanges).toEqual(['scratch/unknown.txt']);
  });

  it('uses conservative states for inferred, missing, unverified, and drifted notes', () => {
    const result = auditDomainSync({
      currentCommit: 'head',
      indexedCommit: 'head',
      databaseRevision: 9,
      changedPaths: ['services/billing/src/wallet.ts'],
      rules: [],
      evidence: [
        {
          domain: 'Customer provisioning',
          path: 'services/billing/src/wallet.ts',
          ref: 'knowledge:item-2:v1',
        },
      ],
      projections: [
        {
          domain: 'Customer provisioning',
          notePath: 'Published/customer.md',
          projectionRevision: 9,
          lastSyncedCommit: 'base',
          evidenceState: 'current',
        },
        {
          domain: 'Server control',
          notePath: 'Published/server.md',
          projectionRevision: 8,
          lastSyncedCommit: 'base',
          evidenceState: 'unverified',
        },
        {
          domain: 'Missing domain',
          notePath: 'Published/missing.md',
          evidenceState: 'missing',
        },
      ],
      comparisonComplete: true,
    });

    expect(result.domains).toEqual([
      expect.objectContaining({ name: 'Customer provisioning', state: 'possibly_stale' }),
      expect.objectContaining({ name: 'Missing domain', state: 'missing' }),
      expect.objectContaining({ name: 'Server control', state: 'stale' }),
    ]);
  });

  it('keeps unrelated domains current when a dirty path is explicitly owned', () => {
    const result = auditDomainSync({
      currentCommit: 'head',
      currentDirtyHash: 'dirty-2',
      indexedCommit: 'head',
      indexedDirtyHash: 'dirty-2',
      databaseRevision: 7,
      changedPaths: ['services/billing/wallet.ts'],
      rules: [
        { domain: 'Customer provisioning', pattern: 'services/billing/**' },
        { domain: 'Server control', pattern: 'services/host-agent/**' },
      ],
      evidence: [],
      projections,
      comparisonComplete: true,
    });

    expect(result.domains).toEqual([
      expect.objectContaining({ name: 'Customer provisioning', state: 'stale' }),
      expect.objectContaining({ name: 'Server control', state: 'current' }),
    ]);
  });

  it('reports current only when an exact projection has complete comparison and evidence', () => {
    const result = auditDomainSync({
      currentCommit: 'head',
      currentDirtyHash: 'dirty-exact',
      indexedCommit: 'head',
      indexedDirtyHash: 'dirty-exact',
      databaseRevision: 11,
      changedPaths: [],
      rules: [{ domain: 'Server control', pattern: 'services/host-agent/**' }],
      evidence: [
        {
          domain: 'Server control',
          path: 'services/host-agent/src/rcon.ts',
          ref: 'knowledge:item-3:v4',
        },
      ],
      projections: [
        {
          domain: 'Server control',
          notePath: 'Published/server.md',
          projectionRevision: 11,
          lastSyncedCommit: 'head',
          lastSyncedDirtyHash: 'dirty-exact',
          evidenceState: 'current',
        },
      ],
      comparisonComplete: true,
    });

    expect(result.domains[0]).toEqual(
      expect.objectContaining({
        state: 'current',
        evidenceRefs: ['knowledge:item-3:v4'],
      }),
    );
  });

  it('does not report current when Git comparison is incomplete', () => {
    const result = auditDomainSync({
      currentCommit: 'head',
      databaseRevision: 7,
      changedPaths: [],
      rules: [{ domain: 'Server control', pattern: 'services/host-agent/**' }],
      evidence: [],
      projections: [projections[0]!],
      comparisonComplete: false,
    });
    expect(result.domains[0]?.state).toBe('possibly_stale');
  });
});
