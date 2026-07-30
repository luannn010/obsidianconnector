import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRegistry } from '../../src/config/registry.js';
import { createServer } from '../../src/server.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('MCP server integration', () => {
  it('exposes every required tool and safely handles representative operations', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'obsidian-mcp-integration-'),
    );
    roots.push(root);
    const registry = await VaultRegistry.load(path.join(root, 'config.json'));
    await registry.register('notes', root);
    const server = createServer(registry);
    const client = new Client(
      { name: 'test-client', version: '0.1.0' },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'list_vaults',
        'get_vault',
        'create_vault',
        'register_vault',
        'unregister_vault',
        'list_directory',
        'create_directory',
        'list_notes',
        'search_notes',
        'read_note',
        'create_note',
        'update_note',
        'append_note',
        'move_note',
        'delete_note',
        'get_frontmatter',
        'update_frontmatter',
        'list_tags',
        'list_backlinks',
        'append_daily_note',
      ]),
    );

    const vaults = await client.callTool({
      name: 'list_vaults',
      arguments: {},
    });
    expect(vaults.isError).not.toBe(true);
    await client.callTool({
      name: 'create_note',
      arguments: { vault: 'notes', path: 'one.md', content: '# One\n#tag' },
    });
    await client.callTool({
      name: 'create_note',
      arguments: { vault: 'notes', path: 'two.md', content: '[[one]]' },
    });
    const backlinks = await client.callTool({
      name: 'list_backlinks',
      arguments: { vault: 'notes', path: 'one.md' },
    });
    expect(JSON.stringify(backlinks)).toContain('two.md');
    const invalid = await client.callTool({
      name: 'read_note',
      arguments: { vault: 'notes', path: '../secret.md' },
    });
    expect(invalid.isError).toBe(true);
    await client.close();
    await server.close();
  });
});
