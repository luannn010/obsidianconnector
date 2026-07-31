import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './tool-utils.js';
import { readOnlyAnnotations, runTool } from './tool-utils.js';

export function registerProjectTools(
  server: McpServer,
  context: ToolContext,
): void {
  server.registerTool(
    'get_project_context',
    {
      description:
        'Read the canonical project notes from a registered vault with bounded content and missing-note reporting.',
      inputSchema: {
        vault: z.string().min(1),
        maxChars: z.number().int().min(1000).max(100000).default(30000),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ vault, maxChars }) =>
      runTool(
        async () => context.project.getContext(vault, maxChars),
        (data) => `${data.notes.length} project note(s) inspected`,
      ),
  );

  server.registerTool(
    'get_project_activity',
    {
      description:
        'Extract current project tasks, decisions, risks, changelog entries, and recent daily notes.',
      inputSchema: {
        vault: z.string().min(1),
        dailyLimit: z.number().int().min(1).max(30).default(10),
        maxChars: z.number().int().min(1000).max(100000).default(20000),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ vault, dailyLimit, maxChars }) =>
      runTool(
        async () => context.project.getActivity(vault, dailyLimit, maxChars),
        (data) =>
          `${data.tasks.length} task(s), ${data.dailyNotes.length} daily note(s)`,
      ),
  );
}
