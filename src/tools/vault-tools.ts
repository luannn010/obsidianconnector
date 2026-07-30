import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './tool-utils.js';
import {
  closedWorldAnnotations,
  readOnlyAnnotations,
  runTool,
} from './tool-utils.js';

const vaultName = z.string().trim().min(1);

export function registerVaultTools(
  server: McpServer,
  context: ToolContext,
): void {
  server.registerTool(
    'list_vaults',
    {
      description:
        'List the explicitly registered Obsidian vaults available for selection.',
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () =>
      runTool(
        async () => ({ vaults: context.registry.list() }),
        (data) => `${data.vaults.length} registered vault(s)`,
      ),
  );

  server.registerTool(
    'get_vault',
    {
      description: 'Get metadata for one registered vault by name.',
      inputSchema: { vault: vaultName },
      annotations: readOnlyAnnotations,
    },
    async ({ vault }) =>
      runTool(
        async () => ({ vault: context.registry.get(vault) }),
        () => `Loaded vault ${vault}`,
      ),
  );

  const registrationSchema = {
    name: vaultName,
    path: z.string().min(1),
    readOnly: z.boolean().optional(),
    dailyDirectory: z.string().min(1).optional(),
    dateFormat: z.string().min(1).optional(),
  };
  server.registerTool(
    'register_vault',
    {
      description: 'Register an existing Obsidian vault path for safe access.',
      inputSchema: registrationSchema,
      annotations: closedWorldAnnotations,
    },
    async ({ name, path, readOnly, dailyDirectory, dateFormat }) =>
      runTool(
        async () => ({
          vault: await context.registry.register(
            name,
            path,
            readOnly ?? false,
            { directory: dailyDirectory, dateFormat },
          ),
        }),
        () => `Registered vault ${name}`,
      ),
  );

  server.registerTool(
    'create_vault',
    {
      description: 'Create a new local vault directory and register it.',
      inputSchema: registrationSchema,
      annotations: closedWorldAnnotations,
    },
    async ({ name, path, readOnly, dailyDirectory, dateFormat }) =>
      runTool(
        async () => ({
          vault: await context.registry.create(name, path, readOnly ?? false, {
            directory: dailyDirectory,
            dateFormat,
          }),
        }),
        () => `Created vault ${name}`,
      ),
  );

  server.registerTool(
    'unregister_vault',
    {
      description:
        'Remove a vault from the local registry without deleting its files.',
      inputSchema: { vault: vaultName },
      annotations: closedWorldAnnotations,
    },
    async ({ vault }) =>
      runTool(
        async () => {
          await context.registry.unregister(vault);
          return { vault };
        },
        () => `Unregistered vault ${vault}`,
      ),
  );
}
