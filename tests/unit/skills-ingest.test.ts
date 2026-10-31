import { describe, expect, it } from 'vitest';
import {
  SkillIngestValidationError,
  batchSkillChanges,
  buildSkillKnowledgeItems,
  planSkillChanges,
  prepareSkillChangeBatches,
  stripDomainPrefix,
  type ExistingSkillKnowledgeItem,
  type SkillRepositoryFile,
} from '../../src/skills/skill-ingest.js';

const commit = '0123456789abcdef0123456789abcdef01234567';

function skillFile(
  domain: string,
  name: string,
  frontmatter: string,
  content = '# Procedure\n\nDo the thing.\n',
): SkillRepositoryFile {
  return {
    relativePath: `skills/${domain}/${name}/SKILL.md`,
    text: `---\n${frontmatter}\n---\n${content}`,
  };
}

describe('skills ingest planning', () => {
  it('strips the numeric ordering prefix from a domain folder', () => {
    expect(stripDomainPrefix('04-implementation')).toBe('implementation');
    expect(stripDomainPrefix('operations')).toBe('operations');
  });

  it.each([
    {
      label: 'missing description',
      file: skillFile('01-core', 'deploy-service', 'name: deploy-service'),
      message: 'description must be a non-empty string',
    },
    {
      label: 'folder/name mismatch',
      file: skillFile(
        '01-core',
        'deploy-service',
        'name: deploy-other\ndescription: Deploy a service',
      ),
      message: 'must equal folder name "deploy-service"',
    },
    {
      label: 'invalid name format',
      file: skillFile(
        '01-core',
        'Deploy_Service',
        'name: Deploy_Service\ndescription: Deploy a service',
      ),
      message: 'must match',
    },
    {
      label: 'invalid owner',
      file: skillFile(
        '01-core',
        'deploy-service',
        'name: deploy-service\ndescription: Deploy a service\nowner: nobody',
      ),
      message: 'owner must be one of',
    },
    {
      label: 'non-string owner',
      file: skillFile(
        '01-core',
        'deploy-service',
        'name: deploy-service\ndescription: Deploy a service\nowner: 123',
      ),
      message: 'owner must be one of',
    },
  ])('rejects invalid frontmatter: $label', ({ file, message }) => {
    expect(() => buildSkillKnowledgeItems([file], commit)).toThrowError(
      SkillIngestValidationError,
    );
    expect(() => buildSkillKnowledgeItems([file], commit)).toThrowError(
      message,
    );
  });

  it('rejects executable frontmatter without evaluating it', () => {
    const marker = '__skillsIngestJavascriptFrontmatter';
    const globals = globalThis as Record<string, unknown>;
    delete globals[marker];
    const file: SkillRepositoryFile = {
      relativePath: 'skills/01-core/unsafe-skill/SKILL.md',
      text: `---javascript\n({ name: 'unsafe-skill', description: 'Unsafe', sideEffect: (globalThis.${marker} = true) })\n---\n# Unsafe`,
    };

    expect(() => buildSkillKnowledgeItems([file], commit)).toThrowError(
      'only YAML frontmatter is supported',
    );
    expect(globals[marker]).toBeUndefined();
  });

  it('rejects cyclic YAML properties before change planning', () => {
    const file = skillFile(
      '01-core',
      'cyclic-skill',
      'name: cyclic-skill\ndescription: Cyclic skill\ncycle: &cycle\n  self: *cycle',
    );

    expect(() => buildSkillKnowledgeItems([file], commit)).toThrowError(
      'must contain only JSON-compatible values',
    );
  });

  it('rejects duplicate skill names across domains', () => {
    const files = [
      skillFile(
        '01-core',
        'deploy-service',
        'name: deploy-service\ndescription: Deploy a service',
      ),
      skillFile(
        '04-implementation',
        'deploy-service',
        'name: deploy-service\ndescription: Deploy it elsewhere',
      ),
    ];

    expect(() => buildSkillKnowledgeItems(files, commit)).toThrowError(
      'Duplicate skill name "deploy-service"',
    );
  });

  it('builds stable skill and reference keys with normalized metadata', () => {
    const files: SkillRepositoryFile[] = [
      skillFile(
        '04-implementation',
        'deploy-service',
        'name: deploy-service\ndescription: Deploy a service\nowner: codex',
        '# Procedure\r\n\r\nShip it.\r\n',
      ),
      {
        relativePath:
          'skills/04-implementation/deploy-service/references/checklist.md',
        text: '# Checklist\r\n\r\n- Verify health\r\n',
      },
    ];

    const items = buildSkillKnowledgeItems(files, commit);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: 'other:skill',
      stableKey: 'skill:deploy-service',
      title: 'deploy-service',
      domain: 'implementation',
      bodyMarkdown: 'Deploy a service\n\n# Procedure\n\nShip it.',
      properties: {
        name: 'deploy-service',
        description: 'Deploy a service',
        owner: 'codex',
        path: 'skills/04-implementation/deploy-service/SKILL.md',
        gitCommit: commit,
      },
    });
    expect(items[1]).toMatchObject({
      kind: 'other:skill-reference',
      stableKey: 'skill:deploy-service:ref:checklist',
      title: 'deploy-service/checklist',
      domain: 'implementation',
      bodyMarkdown: '# Checklist\n\n- Verify health',
      properties: {
        skill: 'deploy-service',
        path: 'skills/04-implementation/deploy-service/references/checklist.md',
        gitCommit: commit,
      },
    });
    expect(items[0]?.properties.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(items[1]?.properties.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('plans create, patch, unchanged, and retirement changes', () => {
    const candidates = buildSkillKnowledgeItems(
      [
        skillFile(
          '01-core',
          'new-skill',
          'name: new-skill\ndescription: New skill',
        ),
        skillFile(
          '01-core',
          'changed-skill',
          'name: changed-skill\ndescription: Changed skill',
        ),
        skillFile(
          '01-core',
          'same-skill',
          'name: same-skill\ndescription: Same skill',
        ),
      ],
      commit,
    );
    const changed = candidates.find(
      (candidate) => candidate.stableKey === 'skill:changed-skill',
    )!;
    const same = candidates.find(
      (candidate) => candidate.stableKey === 'skill:same-skill',
    )!;
    const existing: ExistingSkillKnowledgeItem[] = [
      {
        id: 'changed-id',
        stableKey: changed.stableKey,
        kind: changed.kind,
        currentVersion: 3,
        contentHash: 'old-hash',
        deliveryStatus: null,
        supersededBy: null,
      },
      {
        id: 'same-id',
        stableKey: same.stableKey,
        kind: same.kind,
        currentVersion: 7,
        contentHash: same.properties.contentHash,
        deliveryStatus: null,
        supersededBy: null,
      },
      {
        id: 'removed-id',
        stableKey: 'skill:removed-skill',
        kind: 'other:skill',
        currentVersion: 2,
        contentHash: 'removed-hash',
        deliveryStatus: 'active',
        supersededBy: null,
      },
    ];

    const plan = planSkillChanges(candidates, existing);

    expect(plan.summary).toEqual({
      created: 1,
      updated: 1,
      unchanged: 1,
      superseded: 1,
    });
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'create',
          item: expect.objectContaining({ stableKey: 'skill:new-skill' }),
        }),
        expect.objectContaining({
          operation: 'patch',
          expectedVersion: 3,
          item: expect.objectContaining({
            id: 'changed-id',
            stableKey: 'skill:changed-skill',
          }),
        }),
        {
          operation: 'patch',
          expectedVersion: 2,
          item: { id: 'removed-id', deliveryStatus: 'retired' },
        },
      ]),
    );
    expect(plan.changes).toHaveLength(3);
  });

  it('does not retire items already retired or superseded', () => {
    const existing: ExistingSkillKnowledgeItem[] = [
      {
        id: 'retired-id',
        stableKey: 'skill:retired',
        kind: 'other:skill',
        currentVersion: 2,
        contentHash: 'hash',
        deliveryStatus: 'retired',
        supersededBy: null,
      },
      {
        id: 'superseded-id',
        stableKey: 'skill:superseded',
        kind: 'other:skill',
        currentVersion: 4,
        contentHash: 'hash',
        deliveryStatus: null,
        supersededBy: 'replacement-id',
      },
    ];

    expect(planSkillChanges([], existing)).toEqual({
      changes: [],
      summary: { created: 0, updated: 0, unchanged: 2, superseded: 0 },
    });
  });

  it.each([
    { label: 'identical', existingHash: 'candidate' },
    { label: 'changed', existingHash: 'old-hash' },
  ])(
    'reactivates a restored retired skill with $label content',
    ({ existingHash }) => {
      const [candidate] = buildSkillKnowledgeItems(
        [
          skillFile(
            '01-core',
            'restored-skill',
            'name: restored-skill\ndescription: Restored skill',
          ),
        ],
        commit,
      );
      const contentHash =
        existingHash === 'candidate'
          ? candidate!.properties.contentHash
          : existingHash;

      const plan = planSkillChanges(
        [candidate!],
        [
          {
            id: 'restored-id',
            stableKey: 'skill:restored-skill',
            kind: 'other:skill',
            currentVersion: 5,
            contentHash,
            deliveryStatus: 'retired',
            supersededBy: null,
          },
        ],
      );

      expect(plan.summary).toEqual({
        created: 0,
        updated: 1,
        unchanged: 0,
        superseded: 0,
      });
      expect(plan.changes).toEqual([
        expect.objectContaining({
          operation: 'patch',
          expectedVersion: 5,
          item: expect.objectContaining({
            id: 'restored-id',
            deliveryStatus: 'active',
          }),
        }),
      ]);
    },
  );

  it('batches 45 changes as 20, 20, and 5', () => {
    const changes = Array.from({ length: 45 }, (_, index) => ({
      operation: 'create' as const,
      item: {
        kind: 'other:skill',
        stableKey: `skill:test-${index}`,
        title: `test-${index}`,
      },
    }));

    expect(batchSkillChanges(changes).map((batch) => batch.length)).toEqual([
      20, 20, 5,
    ]);
    const prepared = prepareSkillChangeBatches(changes);
    expect(prepared.map(({ changes: batch }) => batch.length)).toEqual([
      20, 20, 5,
    ]);
    expect(prepared.every(({ hash }) => /^[a-f0-9]{64}$/u.test(hash))).toBe(
      true,
    );
  });
});
