import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import matter from 'gray-matter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultRegistry } from '../../src/config/registry.js';
import { IdeaError } from '../../src/ideas/errors.js';
import {
  IdeaWorkspace,
  MAX_PROTOTYPE_BYTES,
  scaffoldIdeaWorkspace,
  type IdeaProjectResolver,
} from '../../src/ideas/idea-workspace.js';
import type { KnowledgeStore } from '../../src/knowledge/types.js';
import { createServer } from '../../src/server.js';
import { FilesystemService } from '../../src/services/filesystem-service.js';

const roots: string[] = [];
const projects: IdeaProjectResolver = {
  resolve: async () => ({ vaultName: 'lunar', repositoryPath: 'C:/repo' }),
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function fakeKnowledge() {
  const writeProjectKnowledge = vi.fn(async () => ({
    changes: [{ itemId: 'item-1' }],
  }));
  return {
    knowledge: { writeProjectKnowledge } as unknown as KnowledgeStore,
    writeProjectKnowledge,
  };
}

async function setup(knowledge?: KnowledgeStore) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'idea-workspace-'));
  roots.push(root);
  const vaultDir = path.join(root, 'vault');
  await mkdir(vaultDir);
  const registry = await VaultRegistry.load(path.join(root, 'config.json'));
  await registry.register('lunar', vaultDir);
  const files = new FilesystemService(registry);
  return {
    root,
    vaultDir,
    registry,
    files,
    workspace: new IdeaWorkspace(registry, files, projects, knowledge),
  };
}

async function seedCard(
  workspace: IdeaWorkspace,
  files: FilesystemService,
  title = 'Moon panel',
) {
  await files.createNote('lunar', 'Ideas.md', '- Build a moon panel\n');
  const idea = (await workspace.listIdeas({ projectKey: 'lunar' })).ideas[0]!;
  const result = await workspace.createCards({
    projectKey: 'lunar',
    idempotencyKey: `seed-${title}`,
    cards: [
      {
        ideaRefs: [idea.ref],
        title,
        problem: 'There is no panel.',
        proposal: 'Build one.',
        acceptance: ['The panel opens'],
      },
    ],
  });
  return result.cards[0]!.slug;
}

async function readCard(vaultDir: string, slug: string) {
  return matter(
    await readFile(
      path.join(vaultDir, 'Board', 'Cards', slug, 'card.md'),
      'utf8',
    ),
  );
}

describe('IdeaWorkspace', () => {
  it('lists ideas, merges refs into a card, links sources, and replays without duplication', async () => {
    const fake = fakeKnowledge();
    const { vaultDir, files, workspace } = await setup(fake.knowledge);
    await files.createNote(
      'lunar',
      'Ideas.md',
      '- Faster search\n- Search filters\n- Offline mode\n',
    );
    const initial = await workspace.listIdeas({ projectKey: 'lunar' });
    expect(initial.ideas).toHaveLength(3);
    const request = {
      projectKey: 'lunar',
      idempotencyKey: 'triage-search',
      cards: [
        {
          ideaRefs: [initial.ideas[0]!.ref, initial.ideas[1]!.ref],
          title: 'Improve search',
          problem: 'Search is slow and hard to narrow.',
          proposal: 'Add indexing and filters.',
          acceptance: ['Results arrive quickly', 'Filters can be combined'],
        },
      ],
    };

    const created = await workspace.createCards(request);

    expect(created.cards).toEqual([
      expect.objectContaining({ slug: 'improve-search', outcome: 'created' }),
    ]);
    const card = await readCard(vaultDir, 'improve-search');
    expect(card.data).toMatchObject({
      knowledge_id: 'item-1',
      status: 'backlog',
    });
    const ideasNote = await readFile(path.join(vaultDir, 'Ideas.md'), 'utf8');
    expect(
      ideasNote.match(/Board\/Cards\/improve-search\/card/gu),
    ).toHaveLength(2);
    expect((await workspace.listIdeas({ projectKey: 'lunar' })).ideas).toEqual([
      expect.objectContaining({ text: 'Offline mode' }),
    ]);

    const replay = await workspace.createCards(request);
    expect(replay.cards[0]?.outcome).toBe('existing');
    expect(fake.writeProjectKnowledge).toHaveBeenCalledTimes(1);
    const cardsRoot = path.join(vaultDir, 'Board', 'Cards');
    expect(
      await readFile(path.join(cardsRoot, 'improve-search', 'card.md'), 'utf8'),
    ).toBeTruthy();
    await expect(
      access(path.join(cardsRoot, 'improve-search-2')),
    ).rejects.toThrow();
  });

  it('rejects an unknown idea ref with an IdeaError', async () => {
    const { workspace } = await setup();

    await expect(
      workspace.createCards({
        projectKey: 'lunar',
        idempotencyKey: 'unknown-ref',
        cards: [
          {
            ideaRefs: ['idea-missing'],
            title: 'Missing',
            problem: 'Missing.',
            proposal: 'Find it.',
            acceptance: ['It is found'],
          },
        ],
      }),
    ).rejects.toThrow(IdeaError);
  });

  it('keeps a created card and returns a warning when knowledge storage fails', async () => {
    const writeProjectKnowledge = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    const { vaultDir, files, workspace } = await setup({
      writeProjectKnowledge,
    } as unknown as KnowledgeStore);
    await files.createNote('lunar', 'Ideas.md', '- Build a moon panel\n');
    const idea = (await workspace.listIdeas({ projectKey: 'lunar' })).ideas[0]!;
    const created = await workspace.createCards({
      projectKey: 'lunar',
      idempotencyKey: 'resilient-card',
      cards: [
        {
          ideaRefs: [idea.ref],
          title: 'Resilient card',
          problem: 'There is no panel.',
          proposal: 'Build one.',
          acceptance: ['The panel opens'],
        },
      ],
    });
    const slug = created.cards[0]!.slug;

    const card = await readCard(vaultDir, slug);
    expect(card.data.knowledge_id).toBeNull();
    expect(writeProjectKnowledge).toHaveBeenCalledOnce();
    expect(created.warnings).toEqual([
      'Card saved in the vault, but project knowledge was not updated: database unavailable',
    ]);
    const result = await workspace.createCards({
      projectKey: 'lunar',
      idempotencyKey: 'replay-resilient',
      cards: [
        {
          ideaRefs: [card.data.idea_ref as string],
          title: 'Resilient card',
          problem: 'There is no panel.',
          proposal: 'Build one.',
          acceptance: ['The panel opens'],
        },
      ],
    });
    expect(result.cards[0]?.outcome).toBe('existing');
    expect(result.warnings).toEqual([]);
  });

  it('stores a null knowledge id when no knowledge store is configured', async () => {
    const { vaultDir, files, workspace } = await setup();
    const slug = await seedCard(workspace, files, 'Local-only card');

    expect((await readCard(vaultDir, slug)).data.knowledge_id).toBeNull();
  });

  it('writes plan, HTML, SVG, and spike artifacts and updates card frontmatter', async () => {
    const { vaultDir, files, workspace } = await setup();
    const slug = await seedCard(workspace, files);

    await workspace.attachArtifact({
      projectKey: 'lunar',
      slug,
      type: 'plan',
      title: 'Delivery plan',
      content: '# Plan',
    });
    await workspace.attachArtifact({
      projectKey: 'lunar',
      slug,
      type: 'html',
      title: 'Panel Demo',
      content: '<main>demo</main>',
    });
    await workspace.attachArtifact({
      projectKey: 'lunar',
      slug,
      type: 'diagram',
      title: 'Panel Flow',
      diagramFormat: 'svg',
      content: '<svg></svg>',
    });
    await workspace.attachArtifact({
      projectKey: 'lunar',
      slug,
      type: 'spike',
      title: 'Explore panel',
      branch: 'spike/panel',
    });

    const directory = path.join(vaultDir, 'Board', 'Cards', slug);
    expect(await readFile(path.join(directory, 'plan.md'), 'utf8')).toBe(
      '# Plan',
    );
    expect(
      await readFile(
        path.join(directory, 'prototypes', 'panel-demo.html'),
        'utf8',
      ),
    ).toBe('<main>demo</main>');
    expect(
      await readFile(
        path.join(directory, 'prototypes', 'panel-flow.svg'),
        'utf8',
      ),
    ).toBe('<svg></svg>');
    const card = await readCard(vaultDir, slug);
    expect(card.data.artifacts).toEqual([
      { type: 'plan', title: 'Delivery plan', path: 'plan.md' },
      { type: 'html', title: 'Panel Demo', path: 'prototypes/panel-demo.html' },
      {
        type: 'diagram',
        title: 'Panel Flow',
        path: 'prototypes/panel-flow.svg',
      },
      { type: 'spike', title: 'Explore panel', branch: 'spike/panel' },
    ]);
    expect(card.data.spike_branch).toBe('spike/panel');
  });

  it('rejects missing, oversized, and path-traversing artifact inputs', async () => {
    const { root, files, workspace } = await setup();
    const slug = await seedCard(workspace, files);

    await expect(
      workspace.attachArtifact({
        projectKey: 'lunar',
        slug,
        type: 'html',
        title: 'Empty',
      }),
    ).rejects.toThrow(IdeaError);
    await expect(
      workspace.attachArtifact({
        projectKey: 'lunar',
        slug,
        type: 'html',
        title: 'Huge',
        content: 'x'.repeat(MAX_PROTOTYPE_BYTES + 1),
      }),
    ).rejects.toThrow(/2 MB/u);
    await expect(
      workspace.attachArtifact({
        projectKey: 'lunar',
        slug: '../evil',
        type: 'html',
        title: 'Escape',
        content: 'bad',
      }),
    ).rejects.toThrow(IdeaError);
    await expect(access(path.join(root, 'evil'))).rejects.toThrow();
  });

  it('updates review notes and knowledge status while skipping unchanged status calls', async () => {
    const fake = fakeKnowledge();
    const { vaultDir, files, workspace } = await setup(fake.knowledge);
    const slug = await seedCard(workspace, files);
    fake.writeProjectKnowledge.mockClear();

    await workspace.setStatus({
      projectKey: 'lunar',
      slug,
      status: 'review',
      note: 'Needs screenshots',
    });
    expect((await readCard(vaultDir, slug)).data).toMatchObject({
      status: 'review',
      review_note: 'Needs screenshots',
    });
    expect(fake.writeProjectKnowledge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        changes: [
          {
            operation: 'patch',
            item: { id: 'item-1', deliveryStatus: 'review' },
          },
        ],
      }),
    );

    await workspace.setStatus({ projectKey: 'lunar', slug, status: 'ready' });
    expect((await readCard(vaultDir, slug)).data).toMatchObject({
      status: 'ready',
      review_note: null,
    });
    expect(fake.writeProjectKnowledge).toHaveBeenCalledTimes(2);
    await workspace.setStatus({ projectKey: 'lunar', slug, status: 'ready' });
    expect(fake.writeProjectKnowledge).toHaveBeenCalledTimes(2);
  });
});

describe('scaffoldIdeaWorkspace', () => {
  it('creates project workspace files and preserves edited notes on a second run', async () => {
    const { vaultDir, registry, files } = await setup();

    const first = await scaffoldIdeaWorkspace(registry, files, 'lunar', {
      projectKey: 'lunar',
      repositoryPath: 'C:/repo',
    });
    expect(first.created).toEqual([
      'Ideas.md',
      'Board/Board.md',
      'Board/Prototypes.md',
    ]);
    expect(await readFile(path.join(vaultDir, 'Ideas.md'), 'utf8')).toContain(
      'type: ideas',
    );
    expect(
      await readFile(path.join(vaultDir, 'Board', 'Board.md'), 'utf8'),
    ).toContain('board: ideas');
    expect(
      await readFile(path.join(vaultDir, 'Board', 'Prototypes.md'), 'utf8'),
    ).toContain('board: prototypes');
    expect(
      JSON.parse(
        await readFile(path.join(vaultDir, 'Board', '.project.json'), 'utf8'),
      ),
    ).toEqual({ projectKey: 'lunar', repoPath: 'C:/repo' });

    await writeFile(
      path.join(vaultDir, 'Ideas.md'),
      'My edited ideas\n',
      'utf8',
    );
    const second = await scaffoldIdeaWorkspace(registry, files, 'lunar', {
      projectKey: 'lunar',
      repositoryPath: 'C:/repo',
    });
    expect(second.preserved).toEqual([
      'Ideas.md',
      'Board/Board.md',
      'Board/Prototypes.md',
    ]);
    expect(await readFile(path.join(vaultDir, 'Ideas.md'), 'utf8')).toBe(
      'My edited ideas\n',
    );
  });
});

describe('idea MCP tools', () => {
  it('lists all four tools and returns a safe IdeaError for an unknown ref', async () => {
    const fake = fakeKnowledge();
    const { registry } = await setup(fake.knowledge);
    const server = createServer(registry, {
      profile: 'standard',
      knowledge: fake.knowledge,
      ideaProjects: projects,
    });
    const client = new Client(
      { name: 'idea-tools-test', version: '1' },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(
        names.filter((name) => name.includes('idea') || name.includes('card')),
      ).toEqual([
        'list_project_ideas',
        'create_idea_cards',
        'attach_card_artifact',
        'set_card_status',
      ]);

      const result = await client.callTool({
        name: 'create_idea_cards',
        arguments: {
          projectKey: 'lunar',
          idempotencyKey: 'missing-ref',
          cards: [
            {
              ideaRefs: ['idea-missing'],
              title: 'Missing idea',
              problem: 'The ref is missing.',
              proposal: 'Reject it.',
              acceptance: ['A useful error is returned'],
            },
          ],
        },
      });
      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Unknown or already triaged idea refs: idea-missing',
          },
        ],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
