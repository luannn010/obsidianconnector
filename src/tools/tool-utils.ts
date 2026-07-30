import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ToolContext {
  registry: import('../config/registry.js').VaultRegistry;
  files: import('../services/filesystem-service.js').FilesystemService;
  search: import('../services/search-service.js').SearchService;
  frontmatter: import('../services/frontmatter-service.js').FrontmatterService;
  dailyNotes: import('../services/daily-note-service.js').DailyNoteService;
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
  const message =
    error instanceof Error ? error.message : 'Tool operation failed';
  return { isError: true, content: [{ type: 'text', text: message }] };
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
