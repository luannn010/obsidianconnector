import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  KNOWLEDGE_KINDS,
  type KnowledgeStore,
  type ProjectSyncActionRunner,
} from '../knowledge/types.js';
import { runTool } from './tool-utils.js';

const projectKey = z.string();
const maxTokens = (fallback: number, maximum: number) =>
  z.number().int().min(100).max(maximum).default(fallback);
const filters = z.record(z.array(z.string())).optional();
const knowledgeChangeItemSchema = z.object({
  id: z.string().optional(),
  stableKey: z.string().optional(),
  kind: z.string().optional(),
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
  expectedHash: z.string().length(64).optional(),
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
        'Return an immutable snapshot; omit maxTokens for the 800-token default. Allowed range: 100–1600.',
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
    'recall_project_knowledge',
    {
      description:
        'Recall project knowledge. Pass knownStateHash for a not_modified receipt when unchanged.',
      inputSchema: {
        projectKey,
        intent: z.enum(['orient', 'find', 'verify', 'catch_up']),
        query: z.string().optional(),
        worktreePath: z.string().optional(),
        worktreeId: z.string().uuid().optional(),
        taskId: z.string().optional(),
        filters,
        knownStateHash: z.string().length(64).optional(),
        knownItemHashes: z.record(z.string()).optional(),
        maxTokens: maxTokens(600, 2000),
      },
    },
    async (input) =>
      runTool(
        () => knowledge.recallProjectKnowledge(input),
        (data) =>
          data.status === 'not_modified'
            ? `Knowledge unchanged; state ${data.stateHash.slice(0, 8)}`
            : `${data.results.length} changed knowledge result(s); state ${data.stateHash.slice(0, 8)}`,
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
      description: `Write versioned knowledge. Case-normalized kinds: ${KNOWLEDGE_KINDS.join(', ')}, or other:<slug> (lowercase letters, digits, hyphens).`,
      inputSchema: {
        projectKey,
        actor: z.string(),
        taskId: z.string().optional(),
        message: z.string().trim().min(1).max(160).optional(),
        reason: z
          .enum([
            'progress',
            'status_change',
            'decision',
            'correction',
            'evidence_refresh',
            'risk',
            'supersede',
          ])
          .optional(),
        idempotencyKey: z.string().trim().min(1).max(200).optional(),
        expectedProjectRevision: z.number().int().min(0).optional(),
        changes: z.array(knowledgeChangeSchema).min(1).max(20),
      },
    },
    async (input) =>
      runTool(
        () => knowledge.writeProjectKnowledge(input),
        (data) => {
          const hashes = data.changes
            .slice(0, 3)
            .map((change) => change.canonicalHash.slice(0, 8))
            .join(',');
          return `Revision ${data.revisionBefore} → ${data.revisionAfter}: ${data.summary.created} created, ${data.summary.updated} updated, ${data.summary.unchanged} unchanged; hashes ${hashes || 'none'}; ${data.message}`;
        },
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

  const namedViewInputs = {
    projectKey,
    worktreePath: z.string(),
    vaultPath: z.string().optional(),
    views: z
      .array(z.enum(['project-now', 'worktree-now']))
      .max(2)
      .optional(),
    worktreeIds: z.array(z.string().uuid()).max(50).optional(),
  };

  server.registerTool(
    'preview_project_views',
    {
      description:
        'Preview changed lazy views without writing or returning Markdown.',
      inputSchema: {
        ...namedViewInputs,
        knownPreviewHash: z.string().length(64).optional(),
      },
    },
    async (input) =>
      runTool(
        () => syncActions.previewProjectViews(input),
        (data) =>
          data.status === 'not_modified'
            ? `Named views unchanged; preview ${data.previewHash.slice(0, 8)}`
            : `${data.estimatedWrites} named view(s) would change; preview ${data.previewHash.slice(0, 8)}`,
      ),
  );

  server.registerTool(
    'materialize_project_views',
    {
      description: 'Publish changed lazy views using the exact preview hash.',
      inputSchema: {
        ...namedViewInputs,
        previewHash: z.string().length(64),
      },
    },
    async (input) =>
      runTool(
        () => syncActions.materializeProjectViews(input),
        (data) =>
          `${data.published} published, ${data.unchanged} unchanged, ${data.conflicted} conflicted at revision ${data.dbRevision}`,
      ),
  );

  server.registerTool(
    'finalize_projection',
    {
      description:
        'Generate Published notes; blocks on failed jobs, projection conflicts, or non-projection actions.',
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
        'Run a suggested sync-status action: REINDEX_SOURCE or FINALIZE_PROJECTION. Use write_project_knowledge for semantic changes.',
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

  server.registerTool(
    'sync_project_on_demand',
    {
      description:
        'Sync a clean master worktree. Failed-job repair requires repairFailedJobs=true; publishing requires a preview hash.',
      inputSchema: {
        projectKey,
        worktreePath: z.string(),
        vaultPath: z.string().optional(),
        actionId: z.string().optional(),
        domain: z.string().optional(),
        repairFailedJobs: z.boolean(),
        localEmbeddingFallback: z.boolean().default(false),
        timeoutSeconds: z.number().int().positive().max(1800).default(300),
        pollSeconds: z.number().int().positive().max(60).default(5),
        publish: z.boolean().default(false),
        previewHash: z.string().length(64).optional(),
      },
    },
    async (input) =>
      runTool(
        () => syncActions.syncProjectOnDemand(input),
        (data) => {
          const result = data as { state?: string; dbRevision?: number };
          return `On-demand sync ${result.state ?? 'finished'} at revision ${result.dbRevision ?? 'unknown'}`;
        },
      ),
  );
}
