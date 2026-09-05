import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import { runTool } from './tool-utils.js';

const projectKey = z.string();
const maxTokens = (fallback: number, maximum: number) =>
  z.number().int().min(100).max(maximum).default(fallback);
const filters = z.record(z.array(z.string())).optional();

export function registerKnowledgeTools(
  server: McpServer,
  knowledge: KnowledgeStore,
): void {
  server.registerTool(
    'get_project_snapshot',
    {
      description: 'Get project snapshot.',
      inputSchema: {
        projectKey,
        worktreePath: z.string(),
        taskId: z.string().optional(),
        maxTokens: maxTokens(800, 1600),
      },
    },
    async (input) =>
      runTool(
        () => knowledge.getProjectSnapshot(input),
        (data) => `Snapshot ${data.snapshotId} at ${data.gitRevision}`,
      ),
  );

  server.registerTool(
    'search_project_context',
    {
      description: 'Search project context.',
      inputSchema: {
        projectKey,
        snapshotId: z.string().uuid().optional(),
        worktreeId: z.string().uuid().optional(),
        query: z.string(),
        filters,
        mode: z.enum(['auto', 'exact', 'structured', 'hybrid']).default('auto'),
        limit: z.number().int().min(1).max(12).default(6),
        maxTokens: maxTokens(1600, 4000),
        cursor: z.string().optional(),
      },
    },
    async (input) =>
      runTool(
        () => knowledge.searchProjectContext(input),
        (data) => `${data.results.length} revisioned context result(s)`,
      ),
  );

  server.registerTool(
    'expand_project_context',
    {
      description: 'Expand returned refs.',
      inputSchema: {
        projectKey,
        snapshotId: z.string().uuid().optional(),
        refs: z.array(z.string()).min(1).max(8),
        view: z
          .enum([
            'full',
            'parent',
            'neighbors',
            'relations',
            'examples',
            'schema',
          ])
          .default('full'),
        maxTokens: maxTokens(2400, 6000),
      },
    },
    async (input) =>
      runTool(
        () => knowledge.expandProjectContext(input),
        (data) => `${data.results.length} context reference(s) expanded`,
      ),
  );

  server.registerTool(
    'write_project_knowledge',
    {
      description: 'Write versioned knowledge.',
      inputSchema: {
        projectKey,
        actor: z.string(),
        taskId: z.string().optional(),
        expectedProjectRevision: z.number().int().min(0).optional(),
        changes: z.array(z.any()).min(1).max(20),
      },
    },
    async (input) =>
      runTool(
        () => knowledge.writeProjectKnowledge(input),
        (data) =>
          `${data.changes.length} knowledge change(s) committed at revision ${data.dbRevision}`,
      ),
  );

  server.registerTool(
    'get_project_sync_status',
    {
      description: 'Read sync status.',
      inputSchema: {
        projectKey,
        worktreeIds: z.array(z.string().uuid()).max(20).optional(),
        changedOnly: z.boolean().default(true),
      },
    },
    async (input) =>
      runTool(
        () => knowledge.getProjectSyncStatus(input),
        (data) =>
          `${data.queues.pending} pending and ${data.queues.failed} failed sync job(s)`,
      ),
  );
}
