export type KnowledgeErrorCode =
  | 'DB_UNAVAILABLE'
  | 'INDEX_STALE'
  | 'VERSION_CONFLICT'
  | 'EMBEDDING_UNAVAILABLE'
  | 'PROJECTION_DRIFT'
  | 'DOCS_STALE'
  | 'CURSOR_EXPIRED'
  | 'BUDGET_TOO_SMALL';

export class KnowledgeError extends Error {
  constructor(
    public readonly code: KnowledgeErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }
}
