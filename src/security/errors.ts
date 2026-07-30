export type SecurityErrorCode =
  | 'ABSOLUTE_PATH'
  | 'TRAVERSAL'
  | 'NULL_BYTE'
  | 'EXCLUDED_PATH'
  | 'MARKDOWN_REQUIRED'
  | 'OUTSIDE_VAULT'
  | 'NOT_FOUND';

export class SecurityError extends Error {
  constructor(
    public readonly code: SecurityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SecurityError';
  }
}
