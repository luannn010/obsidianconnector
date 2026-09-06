import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './tool-utils.js';
import {
  closedWorldAnnotations,
  destructiveAnnotations,
  readOnlyAnnotations,
  runTool,
} from './tool-utils.js';

export function registerProjectTools(
  server: McpServer,
  context: ToolContext,
): void {
  server.registerTool(
    'initialize_project',
    {
      description:
        'Create or replace the generated .obsidian-local project mapping files and sync their roles to a registered vault.',
      inputSchema: {
        projectPath: z.string().trim().min(1),
        vault: z.string().trim().min(1),
        overwriteGenerated: z.boolean().default(true),
      },
      annotations: destructiveAnnotations,
    },
    async ({ projectPath, vault, overwriteGenerated }) =>
      runTool(
        async () =>
          context.bootstrap.initialize(projectPath, vault, overwriteGenerated),
        (data) =>
          `Initialized ${data.files.length} project configuration file(s) for ${data.vault}`,
      ),
  );

  server.registerTool(
    'sync_project_config',
    {
      description:
        'Apply the .obsidian-local/mapping.yaml documentation tree to the registered vault mapping without changing vault notes.',
      inputSchema: {
        projectPath: z.string().trim().min(1),
      },
      annotations: closedWorldAnnotations,
    },
    async ({ projectPath }) =>
      runTool(
        async () => context.bootstrap.sync(projectPath),
        (data) =>
          `Synchronized ${data.added.length + data.changed.length} project mapping change(s)`,
      ),
  );

  server.registerTool(
    'get_project_context',
    {
      description:
        'Read the configured codebase index from a registered vault with bounded content, metadata, and verification-gap reporting.',
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
    'verify_codebase_index',
    {
      description:
        'Inspect codebase-index notes and report stale verification, missing notes, and missing evidence paths.',
      inputSchema: {
        vault: z.string().min(1),
        maxChars: z.number().int().min(1000).max(100000).default(30000),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ vault, maxChars }) =>
      runTool(
        async () => context.project.getContext(vault, maxChars),
        (data) =>
          `${data.verificationGaps.length} codebase verification gap(s)`,
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
