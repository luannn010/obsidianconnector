import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRegistry } from '../../src/config/registry.js';
import type {
  KnowledgeStore,
  ProjectSyncActionRunner,
} from '../../src/knowledge/types.js';
import { createServer } from '../../src/server.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function fakeStore(): KnowledgeStore {
  return {
    getProjectSnapshot: async () => ({
      projectKey: 'MC-Platform',
      snapshotId: 'snapshot-1',
      worktreeId: 'worktree-1',
      gitRevision: 'abc123',
      dbRevision: 7,
      freshness: 'current',
      architecture: [],
      completed: [],
      active: [],
      blockers: [],
      constraints: [],
      refs: [],
      budget: { limit: 800, used: 100, truncated: false, omitted: 0 },
    }),
    searchProjectContext: async () => ({
      freshness: 'current',
      gitRevision: 'abc123',
      dbRevision: 7,
      results: [
        {
          ref: 'knowledge:item:1:v1',
          kind: 'architecture',
          title: 'Core',
          excerpt: 'One core deployable',
          citation: 'Architecture/Overview',
          contentHash: 'hash',
        },
      ],
    }),
    expandProjectContext: async () => ({
      freshness: 'current',
      gitRevision: 'abc123',
      dbRevision: 7,
      results: [],
    }),
    writeProjectKnowledge: async (input) => ({
      projectKey: input.projectKey,
      dbRevision: 8,
      changes: input.changes.map((change, index) => ({
        itemId: change.item.id ?? `item-${index + 1}`,
        version: 1,
        canonicalHash: 'hash',
        lexicalState: 'current',
        embeddingState: 'pending',
        projectionState: 'pending',
      })),
    }),
    getProjectSyncStatus: async () => ({
      projectKey: 'MC-Platform',
      dbRevision: 8,
      sourceFreshness: 'current',
      snapshots: [],
      projections: [],
      queues: { pending: 0, failed: 0 },
      conflicts: [],
      documentationFreshness: {},
      tasks: [],
    }),
  };
}

function fakeSyncActions(): ProjectSyncActionRunner {
  return {
    finalizeProjection: async (input) => ({
      projectKey: input.projectKey,
      state: 'current',
      dbRevision: 8,
      before: { queues: { pending: 0, failed: 0 } },
      after: { queues: { pending: 0, failed: 0 } },
      executedActions: [],
      deferredActions: [],
      unresolvedBlockers: [],
      projections: {
        total: 1,
        current: 1,
        drifted: 0,
        stale: 0,
        pending: 0,
        other: 0,
      },
      touchedPaths: ['Published/Architecture.md'],
      timeoutMs: input.timeoutSeconds * 1000,
    }),
    runProjectSyncAction: async (input) => ({
      projectKey: input.projectKey,
      state: 'completed',
      dbRevision: 9,
      before: { queues: { pending: 1, failed: 0 } },
      after: { queues: { pending: 0, failed: 0 } },
      executedActions: [input.action],
      deferredActions: [],
      unresolvedBlockers: [],
      projections: {
        total: 1,
        current: 1,
        drifted: 0,
        stale: 0,
        pending: 0,
        other: 0,
      },
      touchedPaths: ['Published/Architecture.md'],
      timeoutMs: input.timeoutSeconds * 1000,
    }),
  };
}

describe('standard knowledge MCP profile', () => {
  it('exposes seven bounded project-knowledge tools', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'knowledge-mcp-'));
    roots.push(root);
    const registry = await VaultRegistry.load(path.join(root, 'config.json'));
    const knowledge = fakeStore();
    const snapshotInputs: Array<{ maxTokens: number }> = [];
    const getProjectSnapshot = knowledge.getProjectSnapshot;
    knowledge.getProjectSnapshot = async (input) => {
      snapshotInputs.push({ maxTokens: input.maxTokens });
      return getProjectSnapshot(input);
    };
    const server = createServer(registry, {
      profile: 'standard',
      knowledge,
      syncActions: fakeSyncActions(),
    });
    const client = new Client(
      { name: 'test', version: '1' },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'expand_project_context',
      'finalize_projection',
      'get_project_snapshot',
      'get_project_sync_status',
      'run_project_sync_action',
      'search_project_context',
      'write_project_knowledge',
    ]);
    expect(JSON.stringify(tools.tools).length).toBeLessThan(22_000);
    const snapshotTool = tools.tools.find(
      (tool) => tool.name === 'get_project_snapshot',
    );
    expect(snapshotTool).toMatchObject({
      description: expect.stringMatching(/omit.*maxTokens/iu),
      inputSchema: {
        properties: {
          maxTokens: {
            type: 'integer',
            minimum: 100,
            maximum: 1600,
            default: 800,
            description: expect.stringMatching(/default 800.*maximum 1600/iu),
          },
        },
      },
    });
    const statusTool = tools.tools.find(
      (tool) => tool.name === 'get_project_sync_status',
    );
    expect(statusTool).toMatchObject({
      description: expect.stringMatching(/first.*compact/iu),
      inputSchema: {
        properties: {
          compact: { type: 'boolean', default: true },
          changedOnly: { type: 'boolean', default: true },
        },
      },
    });
    const finalizeTool = tools.tools.find(
      (tool) => tool.name === 'finalize_projection',
    );
    expect(finalizeTool).toMatchObject({
      inputSchema: {
        properties: {
          timeoutSeconds: { type: 'integer', default: 300 },
          pollSeconds: { type: 'integer', default: 5 },
          localEmbeddingFallback: { type: 'boolean', default: false },
        },
      },
    });
    const syncActionTool = tools.tools.find(
      (tool) => tool.name === 'run_project_sync_action',
    );
    expect(syncActionTool).toMatchObject({
      inputSchema: {
        properties: {
          action: {
            enum: ['REINDEX_SOURCE', 'FINALIZE_PROJECTION'],
          },
        },
      },
    });
    const adminServer = createServer(registry, { profile: 'admin' });
    const adminClient = new Client(
      { name: 'admin-test', version: '1' },
      { capabilities: {} },
    );
    const [adminClientTransport, adminServerTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      adminServer.connect(adminServerTransport),
      adminClient.connect(adminClientTransport),
    ]);
    const adminTools = await adminClient.listTools();
    expect(JSON.stringify(tools.tools).length).toBeLessThanOrEqual(
      JSON.stringify(adminTools.tools).length * 0.5,
    );
    await adminClient.close();
    await adminServer.close();

    const snapshot = await client.callTool({
      name: 'get_project_snapshot',
      arguments: { projectKey: 'MC-Platform', worktreePath: 'C:/repo' },
    });
    expect(snapshot.isError).not.toBe(true);
    expect(snapshot.structuredContent).toMatchObject({
      projectKey: 'MC-Platform',
      snapshotId: 'snapshot-1',
    });
    expect(snapshotInputs).toEqual([{ maxTokens: 800 }]);

    const maximumSnapshot = await client.callTool({
      name: 'get_project_snapshot',
      arguments: {
        projectKey: 'MC-Platform',
        worktreePath: 'C:/repo',
        maxTokens: 1600,
      },
    });
    expect(maximumSnapshot.isError).not.toBe(true);
    expect(snapshotInputs.at(-1)).toEqual({ maxTokens: 1600 });

    const oversizedSnapshot = await client.callTool({
      name: 'get_project_snapshot',
      arguments: {
        projectKey: 'MC-Platform',
        worktreePath: 'C:/repo',
        maxTokens: 1601,
      },
    });
    expect(oversizedSnapshot).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: expect.stringMatching(/less than or equal to 1600/iu),
        },
      ],
    });

    const write = await client.callTool({
      name: 'write_project_knowledge',
      arguments: {
        projectKey: 'MC-Platform',
        actor: 'codex',
        changes: [
          { operation: 'create', item: { kind: 'decision', title: 'Use SQL' } },
        ],
      },
    });
    expect(write.isError).not.toBe(true);
    expect(write.structuredContent).toMatchObject({ dbRevision: 8 });

    const finalized = await client.callTool({
      name: 'finalize_projection',
      arguments: {
        projectKey: 'MC-Platform',
        worktreePath: 'C:/repo',
      },
    });
    expect(finalized.isError).not.toBe(true);
    expect(finalized.structuredContent).toMatchObject({
      projectKey: 'MC-Platform',
      state: 'current',
      timeoutMs: 300_000,
    });

    const syncAction = await client.callTool({
      name: 'run_project_sync_action',
      arguments: {
        projectKey: 'MC-Platform',
        action: 'REINDEX_SOURCE',
        worktreePath: 'C:/repo',
      },
    });
    expect(syncAction.isError).not.toBe(true);
    expect(syncAction.structuredContent).toMatchObject({
      projectKey: 'MC-Platform',
      state: 'completed',
      executedActions: ['REINDEX_SOURCE'],
    });

    const unsupported = await client.callTool({
      name: 'run_project_sync_action',
      arguments: {
        projectKey: 'MC-Platform',
        action: 'UPDATE_KNOWLEDGE',
        worktreePath: 'C:/repo',
      },
    });
    expect(unsupported).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: expect.stringMatching(/invalid enum value/iu),
        },
      ],
    });

    await client.close();
    await server.close();
  });
});
