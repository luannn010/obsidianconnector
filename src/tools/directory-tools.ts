import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './tool-utils.js';
import {
  closedWorldAnnotations,
  readOnlyAnnotations,
  runTool,
} from './tool-utils.js';

const directorySchema = {
  vault: z.string().min(1),
  directory: z.string().default(''),
};

export function registerDirectoryTools(
  server: McpServer,
  context: ToolContext,
): void {
  server.registerTool(
    'list_directory',
    {
      description:
        'List Markdown files and safe child directories inside a registered vault directory.',
      inputSchema: directorySchema,
      annotations: readOnlyAnnotations,
    },
    async ({ vault, directory }) =>
      runTool(
        async () => ({
          entries: await context.files.listDirectory(vault, directory),
        }),
        (data) =>
          `${data.entries.length} directory entr${data.entries.length === 1 ? 'y' : 'ies'}`,
      ),
  );
  server.registerTool(
    'create_directory',
    {
      description: 'Create a directory inside a registered writable vault.',
      inputSchema: { vault: z.string().min(1), directory: z.string().min(1) },
      annotations: closedWorldAnnotations,
    },
    async ({ vault, directory }) =>
      runTool(
        async () => context.files.createDirectory(vault, directory),
        (data) => `Created ${data.path}`,
      ),
  );
}
