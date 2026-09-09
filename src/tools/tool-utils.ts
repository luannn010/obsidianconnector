import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SecurityError } from '../security/path-security.js';
import { KnowledgeError } from '../knowledge/errors.js';

export interface ToolContext {
  registry: import('../config/registry.js').VaultRegistry;
  files: import('../services/filesystem-service.js').FilesystemService;
  search: import('../services/search-service.js').SearchService;
  frontmatter: import('../services/frontmatter-service.js').FrontmatterService;
  dailyNotes: import('../services/daily-note-service.js').DailyNoteService;
  project: import('../services/project-context-service.js').ProjectContextService;
  bootstrap: import('../services/project-bootstrap-service.js').ProjectBootstrapService;
}

export const closedWorldAnnotations = { openWorldHint: false } as const;
export const readOnlyAnnotations = {
  openWorldHint: false,
  readOnlyHint: true,
} as const;
export const destructiveAnnotations = {
  openWorldHint: false,
  destructiveHint: true,
} as const;

export function toolSuccess<T extends object>(
  data: T,
  summary: string,
): CallToolResult {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: data as Record<string, unknown>,
  };
}

export function toolFailure(error: unknown): CallToolResult {
  if (error instanceof KnowledgeError) {
    return {
      isError: true,
      content: [{ type: 'text', text: error.message }],
      structuredContent: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }
  const message = safeErrorMessage(error);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof SecurityError) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR')
    return 'Requested path does not exist';
  if (code === 'EACCES' || code === 'EPERM') return 'Access denied';
  if (code === 'EEXIST') return 'Destination already exists';
  if (code === 'EISDIR') return 'Requested path is not a file';
  if (code === 'ENOSPC') return 'Insufficient storage';
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Vault is read-only')) return 'Vault is read-only';
  if (message.startsWith('Vault is not registered'))
    return 'Vault is not registered';
  if (message.startsWith('Vault is already registered'))
    return 'Vault is already registered';
  if (message.startsWith('Vault name')) return 'Invalid vault name';
  if (message.startsWith('Note already exists')) return 'Note already exists';
  if (message.startsWith('Destination already exists'))
    return 'Destination already exists';
  if (message.includes('content hash'))
    return 'Note content hash does not match expected hash';
  if (message.startsWith('Vault directory does not exist'))
    return 'Vault directory does not exist';
  if (message.startsWith('Atomic replacement'))
    return 'Atomic write could not be completed';
  if (message.startsWith('Only regular Markdown files'))
    return 'Only regular Markdown files can be deleted';
  if (message.startsWith('Concurrent update lock'))
    return 'Concurrent update lock was unavailable';
  return 'Tool operation failed';
}

export async function runTool<T extends object>(
  operation: () => Promise<T>,
  summary: (data: T) => string,
): Promise<CallToolResult> {
  try {
    const data = await operation();
    return toolSuccess(data, summary(data));
  } catch (error) {
    return toolFailure(error);
  }
}
