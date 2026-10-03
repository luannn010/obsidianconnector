import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ToolCallRecord } from '@mcp-dashboard/metrics';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRegistry } from '../../src/config/registry.js';
import type { KnowledgeStore } from '../../src/knowledge/types.js';
import { createServer, type ServerOptions } from '../../src/server.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

async function connect(options: ServerOptions) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obsidian-metrics-'));
  roots.push(root);
  const registry = await VaultRegistry.load(path.join(root, 'config.json'), {
    vaultRoot: root,
  });
  const server = createServer(registry, options);
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe('obsidian-local tool-call metrics', () => {
  it('records admin-profile tool calls', async () => {
    const rows: ToolCallRecord[] = [];
    const client = await connect({ metrics: { record: (r) => rows.push(r) } });
    await client.callTool({ name: 'list_vaults', arguments: {} });
    expect(rows).toEqual([
      expect.objectContaining({
        server: 'obsidian-local',
        tool: 'list_vaults',
        ok: true,
        projectKey: null,
      }),
    ]);
  });

  it('records projectKey for standard-profile knowledge tools', async () => {
    const rows: ToolCallRecord[] = [];
    const knowledge = {
      getProjectSnapshot: async () => ({
        snapshotId: 's1',
        gitRevision: 'abc',
      }),
    } as unknown as KnowledgeStore;
    const client = await connect({
      profile: 'standard',
      knowledge,
      metrics: { record: (r) => rows.push(r) },
    });
    await client.callTool({
      name: 'get_project_snapshot',
      arguments: { projectKey: 'MC-Platform', worktreePath: 'C:/x' },
    });
    expect(rows[0]).toMatchObject({
      tool: 'get_project_snapshot',
      projectKey: 'MC-Platform',
      ok: true,
    });
  });

  it('records nothing and still works when metrics are not configured', async () => {
    const client = await connect({});
    const result = await client.callTool({
      name: 'list_vaults',
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
  });
});
