export type Freshness = 'current' | 'stale';
export type SearchMode = 'auto' | 'exact' | 'structured' | 'hybrid';
export type ExpansionView =
  'full' | 'parent' | 'neighbors' | 'relations' | 'examples' | 'schema';

export interface ContextHit {
  ref: string;
  kind: string;
  title: string;
  excerpt: string;
  citation: string;
  contentHash: string;
  itemId?: string;
  itemVersion?: number;
  stableKey?: string;
  estimatedTokens?: number;
  path?: string;
  symbol?: string;
  heading?: string;
  lines?: { start: number; end: number };
  documentationFreshness?:
    'current' | 'possibly_stale' | 'stale' | 'missing' | 'unverified';
}

export interface ProjectSnapshotInput {
  projectKey: string;
  worktreePath: string;
  taskId?: string;
  taskName?: string;
  agent?: 'codex' | 'claude';
  maxTokens: number;
}

export interface ProjectSnapshot {
  projectKey: string;
  snapshotId: string;
  worktreeId: string;
  gitRevision: string;
  dbRevision: number;
  freshness: Freshness;
  architecture: ContextHit[];
  completed: ContextHit[];
  active: ContextHit[];
  blockers: ContextHit[];
  constraints: ContextHit[];
  refs: string[];
  task?: {
    ref: string;
    agent: 'codex' | 'claude';
    taskId: string;
    taskName: string;
  };
  budget: {
    limit: number;
    used: number;
    truncated: boolean;
    omitted: number;
    continuation?: string;
  };
}

export interface SearchProjectContextInput {
  projectKey: string;
  snapshotId?: string;
  worktreeId?: string;
  query: string;
  filters?: {
    kinds?: string[];
    domains?: string[];
    services?: string[];
    statuses?: string[];
  };
  mode: SearchMode;
  limit: number;
  maxTokens: number;
  cursor?: string;
}

export interface ContextResults {
  freshness: Freshness;
  gitRevision: string;
  dbRevision: number;
  results: ContextHit[];
  warnings?: string[];
}

export interface ExpandProjectContextInput {
  projectKey: string;
  snapshotId?: string;
  refs: string[];
  view: ExpansionView;
  maxTokens: number;
}

export type KnowledgeOperation = 'create' | 'patch' | 'append' | 'supersede';
export interface KnowledgeEvidenceInput {
  snapshotId: string;
  ref: string;
  locatorType?: 'path' | 'symbol' | 'endpoint' | 'table' | 'migration' | 'test';
  required?: boolean;
  verificationScope?: 'required' | 'warning';
}
export interface KnowledgeChange {
  operation: KnowledgeOperation;
  expectedVersion?: number;
  supersedesId?: string;
  evidence?: KnowledgeEvidenceInput[];
  item: {
    id?: string;
    stableKey?: string;
    kind: string;
    title?: string;
    bodyMarkdown?: string;
    deliveryStatus?: string;
    verificationStatus?: string;
    domain?: string;
    service?: string;
    properties?: Record<string, unknown>;
  };
}

export interface WriteProjectKnowledgeInput {
  projectKey: string;
  actor: string;
  taskId?: string;
  expectedProjectRevision?: number;
  changes: KnowledgeChange[];
}

export interface KnowledgeWriteResult {
  projectKey: string;
  dbRevision: number;
  changes: Array<{
    itemId: string;
    version: number;
    canonicalHash: string;
    lexicalState: 'current';
    embeddingState: 'pending';
    projectionState: 'pending';
  }>;
}

export interface SyncStatusInput {
  projectKey: string;
  worktreeIds?: string[];
  filters?: Record<string, string[]>;
  changedOnly: boolean;
  compact?: boolean;
  issueLimit?: number;
  actionLimit?: number;
}

export interface DomainSyncStatus {
  worktreeId: string;
  worktreePath: string;
  branch: string;
  currentCommit: string;
  currentDirtyHash?: string;
  indexedCommit?: string;
  indexedDirtyHash?: string;
  snapshotId?: string;
  domains: Array<{
    name: string;
    notePath: string;
    state: 'current' | 'stale' | 'possibly_stale' | 'unverified' | 'missing';
    lastSyncedCommit?: string;
    lastSyncedDirtyHash?: string;
    currentCommit: string;
    currentDirtyHash?: string;
    databaseRevision: number;
    projectionRevision?: number;
    reasons: string[];
    changedPaths: string[];
    evidenceRefs: string[];
  }>;
  unmappedChanges: string[];
  omitted?: {
    domains?: number;
    reasons?: number;
    changedPaths?: number;
    evidenceRefs?: number;
    unmappedChanges?: number;
  };
}

export interface SyncStatusSummary {
  dirtyWorktrees: number;
  staleSources: number;
  staleEvidence: number;
  staleProjections: number;
  pendingJobs: number;
  failedJobs: number;
}

export interface SyncSuggestedAction {
  actionId: string;
  action:
    | 'REINDEX_SOURCE'
    | 'UPDATE_KNOWLEDGE'
    | 'VERIFY_EVIDENCE'
    | 'FINALIZE_PROJECTION';
  summary: string;
  worktreeId: string;
  worktreePath?: string;
  domain?: string;
  changedPaths: string[];
  relatedItemIds?: string[];
  evidenceRefs?: string[];
  estimatedWrites: number;
  estimatedTokens: number;
  dependsOn?: string[];
  omitted?: {
    changedPaths?: number;
    relatedItemIds?: number;
    evidenceRefs?: number;
  };
}

export interface ProjectSyncStatus {
  projectKey: string;
  dbRevision: number;
  sourceFreshness: Freshness;
  summary?: SyncStatusSummary;
  topIssues?: string[];
  topSuggestedActions?: SyncSuggestedAction[];
  cacheKey?: string;
  fingerprint?: string;
  compact?: boolean;
  snapshots: unknown[];
  projections: unknown[];
  queues: { pending: number; failed: number };
  conflicts: unknown[];
  documentationFreshness: Record<string, number>;
  tasks: unknown[];
  domainSync?: DomainSyncStatus;
}

export interface KnowledgeStore {
  getProjectSnapshot(input: ProjectSnapshotInput): Promise<ProjectSnapshot>;
  searchProjectContext(
    input: SearchProjectContextInput,
  ): Promise<ContextResults>;
  expandProjectContext(
    input: ExpandProjectContextInput,
  ): Promise<ContextResults>;
  writeProjectKnowledge(
    input: WriteProjectKnowledgeInput,
  ): Promise<KnowledgeWriteResult>;
  getProjectSyncStatus(input: SyncStatusInput): Promise<ProjectSyncStatus>;
}
