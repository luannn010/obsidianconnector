import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './tool-utils.js';
import {
  closedWorldAnnotations,
  destructiveAnnotations,
  readOnlyAnnotations,
  runTool,
} from './tool-utils.js';

const vault = z.string().min(1);
const notePath = z.string().min(1);

export function registerFileTools(
  server: McpServer,
  context: ToolContext,
): void {
  server.registerTool(
    'list_notes',
    {
      description:
        'List Markdown notes in a registered vault, optionally below a directory.',
      inputSchema: { vault, directory: z.string().default('') },
      annotations: readOnlyAnnotations,
    },
    async ({ vault: name, directory }) =>
      runTool(
        async () => ({ notes: await context.files.listNotes(name, directory) }),
        (data) => `${data.notes.length} note(s)`,
      ),
  );
  server.registerTool(
    'search_notes',
    {
      description:
        'Search registered-vault filenames, Markdown content, tags, and YAML frontmatter with bounded excerpts.',
      inputSchema: {
        vault,
        query: z.string().min(1),
        directory: z.string().default(''),
        limit: z.number().int().positive().max(100).default(20),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ vault: name, query, directory, limit }) =>
      runTool(
        async () => ({
          results: await context.search.search(name, query, limit, directory),
        }),
        (data) => `${data.results.length} search result(s)`,
      ),
  );
  server.registerTool(
    'read_note',
    {
      description: 'Read one Markdown note from a registered vault.',
      inputSchema: { vault, path: notePath },
      annotations: readOnlyAnnotations,
    },
    async ({ vault: name, path }) =>
      runTool(
        async () => context.files.readNote(name, path),
        (data) => `Read ${data.path}`,
      ),
  );
  server.registerTool(
    'create_note',
    {
      description:
        'Create a Markdown note; it fails if the note exists unless overwrite is explicitly true.',
      inputSchema: {
        vault,
        path: notePath,
        content: z.string(),
        overwrite: z.boolean().default(false),
      },
      annotations: closedWorldAnnotations,
    },
    async ({ vault: name, path, content, overwrite }) =>
      runTool(
        async () => context.files.createNote(name, path, content, overwrite),
        (data) => `Created ${data.path}`,
      ),
  );
  server.registerTool(
    'update_note',
    {
      description:
        'Replace a Markdown note, optionally requiring an expected SHA-256 hash for concurrency safety.',
      inputSchema: {
        vault,
        path: notePath,
        content: z.string(),
        expectedHash: z.string().length(64).optional(),
      },
      annotations: closedWorldAnnotations,
    },
    async ({ vault: name, path, content, expectedHash }) =>
      runTool(
        async () => context.files.updateNote(name, path, content, expectedHash),
        (data) => `Updated ${data.path}`,
      ),
  );
  server.registerTool(
    'append_note',
    {
      description:
        'Append content to an existing Markdown note without replacing it.',
      inputSchema: { vault, path: notePath, content: z.string() },
      annotations: closedWorldAnnotations,
    },
    async ({ vault: name, path, content }) =>
      runTool(
        async () => context.files.appendNote(name, path, content),
        (data) => `Appended to ${data.path}`,
      ),
  );
  server.registerTool(
    'move_note',
    {
      description:
        'Move a Markdown note inside a registered vault, rejecting an existing destination by default.',
      inputSchema: {
        vault,
        sourcePath: notePath,
        destinationPath: notePath,
        overwrite: z.boolean().default(false),
      },
      annotations: closedWorldAnnotations,
    },
    async ({ vault: name, sourcePath, destinationPath, overwrite }) =>
      runTool(
        async () =>
          context.files.moveNote(name, sourcePath, destinationPath, overwrite),
        (data) => `Moved to ${data.path}`,
      ),
  );
  server.registerTool(
    'delete_note',
    {
      description:
        'Move a Markdown note to the vault trash instead of permanently deleting it.',
      inputSchema: { vault, path: notePath },
      annotations: destructiveAnnotations,
    },
    async ({ vault: name, path }) =>
      runTool(
        async () => context.files.deleteNote(name, path),
        () => `Moved ${path} to trash`,
      ),
  );
}
