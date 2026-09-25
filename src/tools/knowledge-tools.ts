import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  KnowledgeStore,
  ProjectSyncActionRunner,
} from '../knowledge/types.js';
import { runTool } from './tool-utils.js';

const projectKey = z.string();
const maxTokens = (fallback: number, maximum: number) =>
  z.number().int().min(100).max(maximum).default(fallback);
const filters = z.record(z.array(z.string())).optional();
const knowledgeChangeItemSchema = z.object({
  id: z.string().optional(),
  stableKey: z.string().optional(),
  kind: z.string(),
  title: z.string().optional(),
  bodyMarkdown: z.string().optional(),
  deliveryStatus: z.string().optional(),
  verificationStatus: z.string().optional(),
  domain: z.string().optional(),
  service: z.string().optional(),
  properties: z.record(z.unknown()).optional(),
});
const knowledgeEvidenceSchema = z.object({
  snapshotId: z.string(),
  ref: z.string(),
  locatorType: z
    .enum(['path', 'symbol', 'endpoint', 'table', 'migration', 'test'])
    .optional(),
  required: z.boolean().optional(),
  verificationScope: z.enum(['required', 'warning']).optional(),
});
const knowledgeChangeObjectSchema = z.object({
  operation: z.enum(['create', 'patch', 'append', 'supersede']),
  expectedVersion: z.number().int().min(0).optional(),
  supersedesId: z.string().optional(),
  evidence: z.array(knowledgeEvidenceSchema).optional(),
  item: knowledgeChangeItemSchema,
});
const knowledgeChangeSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}, knowledgeChangeObjectSchema);

export function registerKnowledgeTools(
  server: McpServer,
  knowledge: KnowledgeStore,
  syncActions?: ProjectSyncActionRunner,
): void {
  server.registerTool(
    'get_project_snapshot',
    {
      description:
        'Return a compact, immutable project snapshot. Normally omit maxTokens to use the 800-token default; explicit values must be between 100 and 1600.',
      inputSchema: {
        projectKey,
        worktreePath: z.string(),
        taskId: z.string().optional(),
        maxTokens: maxTokens(800, 1600).describe(
          'Compact snapshot response budget: default 800 tokens, maximum 1600.',
        ),
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
      inputSchema: {
        projectKey,
        actor: z.string(),
        taskId: z.string().optional(),
        expectedProjectRevision: z.number().int().min(0).optional(),
        changes: z.array(knowledgeChangeSchema).min(1).max(20),
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
      description: 'Call first for compact sync status and repair actions.',
      inputSchema: {
        projectKey,
        worktreeIds: z.array(z.string().uuid()).max(20).optional(),
        filters,
        changedOnly: z.boolean().default(true),
        compact: z.boolean().default(true),
      },
    },
    async (input) =>
      runTool(
        () => knowledge.getProjectSyncStatus(input),
        (data) =>
          `${data.sourceFreshness}; ${data.topSuggestedActions?.length ?? 0} action(s), ${data.queues.pending} pending, ${data.queues.failed} failed${data.cacheKey ? `; cache ${data.cacheKey}` : ''}`,
      ),
  );

  if (!syncActions) return;

  server.registerTool(
    'finalize_projection',
    {
      description:
        'Finalize pending SQL-backed project knowledge into generated Obsidian Published notes. Blocks on failed jobs, projection conflicts, or non-projection actions.',
      inputSchema: {
        projectKey,
        worktreePath: z.string(),
        vaultPath: z.string().optional(),
        timeoutSeconds: z.number().int().positive().max(1800).default(300),
        pollSeconds: z.number().int().positive().max(60).default(5),
        localEmbeddingFallback: z.boolean().default(false),
      },
    },
    async (input) =>
      runTool(
        () => syncActions.finalizeProjection(input),
        (data) => {
          const result = data as { state?: string; dbRevision?: number };
          return `Projection ${result.state ?? 'finished'} at revision ${result.dbRevision ?? 'unknown'}`;
        },
      ),
  );

  server.registerTool(
    'run_project_sync_action',
    {
      description:
        'Run a safe get_project_sync_status suggested action. V1 supports REINDEX_SOURCE and FINALIZE_PROJECTION only; semantic knowledge updates still use write_project_knowledge with chunk refs.',
      inputSchema: {
        projectKey,
        action: z.enum(['REINDEX_SOURCE', 'FINALIZE_PROJECTION']),
        actionId: z.string().optional(),
        worktreePath: z.string(),
        vaultPath: z.string().optional(),
        timeoutSeconds: z.number().int().positive().max(1800).default(300),
        pollSeconds: z.number().int().positive().max(60).default(5),
        localEmbeddingFallback: z.boolean().default(false),
      },
    },
    async (input) =>
      runTool(
        () => syncActions.runProjectSyncAction(input),
        (data) => {
          const result = data as {
            state?: string;
            executedActions?: string[];
            dbRevision?: number;
          };
          return `Sync action ${result.state ?? 'finished'} (${result.executedActions?.join(', ') || 'none'}) at revision ${result.dbRevision ?? 'unknown'}`;
        },
      ),
  );
}
