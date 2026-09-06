import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

    const listedTools = (await client.listTools()).tools;
    const toolNames = listedTools.map((tool) => tool.name);
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
        'get_project_context',
        'verify_codebase_index',
        'get_project_activity',
        'initialize_project',
        'sync_project_config',
      ]),
    );
    expect(
      listedTools.find((tool) => tool.name === 'read_note')?.annotations,
    ).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(
      listedTools.find((tool) => tool.name === 'delete_note')?.annotations,
    ).toMatchObject({
      destructiveHint: true,
      openWorldHint: false,
    });
    const createVaultTool = listedTools.find(
      (tool) => tool.name === 'create_vault',
    );
    expect(createVaultTool?.inputSchema).toMatchObject({
      properties: expect.objectContaining({ name: expect.any(Object) }),
    });
    expect(createVaultTool?.inputSchema.properties).not.toHaveProperty('path');

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
    const context = await client.callTool({
      name: 'get_project_context',
      arguments: { vault: 'notes' },
    });
    expect(context.isError).not.toBe(true);
    expect(JSON.stringify(context)).toContain('12 project note(s) inspected');
    const activity = await client.callTool({
      name: 'get_project_activity',
      arguments: { vault: 'notes' },
    });
    expect(activity.isError).not.toBe(true);
    const invalid = await client.callTool({
      name: 'read_note',
      arguments: { vault: 'notes', path: '../secret.md' },
    });
    expect(invalid.isError).toBe(true);
    const absolute = await client.callTool({
      name: 'read_note',
      arguments: { vault: 'notes', path: path.join(root, 'one.md') },
    });
    expect(absolute.isError).toBe(true);
    const hidden = await client.callTool({
      name: 'list_directory',
      arguments: { vault: 'notes', directory: '.obsidian' },
    });
    expect(hidden.isError).toBe(true);
    const missing = await client.callTool({
      name: 'list_directory',
      arguments: { vault: 'notes', directory: 'missing' },
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing)).not.toContain(root);
    await registry.register('readonly', root, true);
    const readOnlyWrite = await client.callTool({
      name: 'create_note',
      arguments: { vault: 'readonly', path: 'blocked.md', content: 'blocked' },
    });
    expect(readOnlyWrite.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it('initializes and synchronizes a customizable project mapping', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'obsidian-mcp-bootstrap-integration-'),
    );
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    const vault = path.join(root, 'vault');
    await mkdir(workspace);
    await mkdir(vault);
    await writeFile(path.join(vault, '00 - Project Home.md'), '# Home\n');
    const registry = await VaultRegistry.load(path.join(root, 'config.json'), {
      vaultRoot: root,
    });
    await registry.register('personal', vault);
    const server = createServer(registry);
    const client = new Client(
      { name: 'bootstrap-test-client', version: '0.1.0' },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const initialized = await client.callTool({
      name: 'initialize_project',
      arguments: { projectPath: workspace, vault: 'personal' },
    });
    expect(initialized.isError).not.toBe(true);
    expect(
      await readFile(
        path.join(workspace, '.obsidian-local', 'mapping.yaml'),
        'utf8',
      ),
    ).toContain('schemaVersion: 1');

    await writeFile(
      path.join(workspace, '.obsidian-local', 'mapping.yaml'),
      'schemaVersion: 1\nvault: personal\ntree:\n  - id: custom\n    title: Custom\n    type: note\n    path: Custom.md\n',
    );
    const synchronized = await client.callTool({
      name: 'sync_project_config',
      arguments: { projectPath: workspace },
    });
    expect(synchronized.isError).not.toBe(true);
    expect(registry.get('personal').codebaseIndex.roles).toEqual({
      custom: 'Custom.md',
    });
    await client.close();
    await server.close();
  });
});
