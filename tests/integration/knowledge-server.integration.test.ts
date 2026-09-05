import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRegistry } from '../../src/config/registry.js';
import type { KnowledgeStore } from '../../src/knowledge/types.js';
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

describe('standard knowledge MCP profile', () => {
  it('exposes exactly five bounded project-knowledge tools', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'knowledge-mcp-'));
    roots.push(root);
    const registry = await VaultRegistry.load(path.join(root, 'config.json'));
    const server = createServer(registry, {
      profile: 'standard',
      knowledge: fakeStore(),
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
      'get_project_snapshot',
      'get_project_sync_status',
      'search_project_context',
      'write_project_knowledge',
    ]);
    expect(JSON.stringify(tools.tools).length).toBeLessThan(18_000);
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
      JSON.stringify(adminTools.tools).length * 0.25,
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

    await client.close();
    await server.close();
  });
});
