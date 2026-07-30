import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './tool-utils.js';
import {
  closedWorldAnnotations,
  readOnlyAnnotations,
  runTool,
} from './tool-utils.js';

function flattenTags(value: unknown): string[] {
  if (typeof value === 'string')
    return value
      .split(/[\s,]+/u)
      .filter(Boolean)
      .map((tag) => (tag.startsWith('#') ? tag.slice(1) : tag));
  if (Array.isArray(value)) return value.flatMap(flattenTags);
  return [];
}

export function registerObsidianTools(
  server: McpServer,
  context: ToolContext,
): void {
  server.registerTool(
    'get_frontmatter',
    {
      description: 'Read YAML frontmatter properties from a Markdown note.',
      inputSchema: { vault: z.string().min(1), path: z.string().min(1) },
      annotations: readOnlyAnnotations,
    },
    async ({ vault, path }) =>
      runTool(
        async () => ({
          vault,
          path,
          frontmatter: await context.frontmatter.get(vault, path),
        }),
        () => `Read frontmatter from ${path}`,
      ),
  );
  server.registerTool(
    'update_frontmatter',
    {
      description:
        'Merge selected YAML frontmatter properties without replacing the note body.',
      inputSchema: {
        vault: z.string().min(1),
        path: z.string().min(1),
        properties: z.record(z.unknown()),
      },
      annotations: closedWorldAnnotations,
    },
    async ({ vault, path, properties }) =>
      runTool(
        async () => context.frontmatter.update(vault, path, properties),
        (data) => `Updated frontmatter in ${data.path}`,
      ),
  );
  server.registerTool(
    'list_tags',
    {
      description:
        'List tags found in note frontmatter and Markdown hashtag syntax.',
      inputSchema: {
        vault: z.string().min(1),
        directory: z.string().default(''),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ vault, directory }) =>
      runTool(
        async () => {
          const counts = new Map<string, number>();
          for (const note of await context.files.listNotes(vault, directory)) {
            const content = await context.files.readNote(vault, note.path);
            for (const tag of flattenTags(
              (await context.frontmatter.get(vault, note.path)).tags,
            ))
              counts.set(tag, (counts.get(tag) ?? 0) + 1);
            for (const match of content.content.matchAll(
              /(?:^|\s)#([\w/-]+)/gmu,
            )) {
              const tag = match[1];
              if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
            }
          }
          return {
            tags: [...counts.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([tag, count]) => ({ tag, count })),
          };
        },
        (data) => `${data.tags.length} tag(s)`,
      ),
  );
  server.registerTool(
    'list_backlinks',
    {
      description:
        'List Markdown notes containing Obsidian wiki links to a target note.',
      inputSchema: { vault: z.string().min(1), path: z.string().min(1) },
      annotations: readOnlyAnnotations,
    },
    async ({ vault, path }) =>
      runTool(
        async () => {
          const target = path.replace(/\\/gu, '/').replace(/\.md$/iu, '');
          const backlinks: string[] = [];
          for (const note of await context.files.listNotes(vault)) {
            const content = (await context.files.readNote(vault, note.path))
              .content;
            const links = [
              ...content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/gu),
            ]
              .map((match) => match[1])
              .filter((link): link is string => Boolean(link))
              .map((link) => link.replace(/\\/gu, '/').replace(/\.md$/iu, ''));
            if (
              links.some(
                (link) =>
                  link === target ||
                  link.endsWith(`/${target}`) ||
                  target.endsWith(`/${link}`),
              )
            )
              backlinks.push(note.path);
          }
          return { backlinks };
        },
        (data) => `${data.backlinks.length} backlink(s)`,
      ),
  );
  server.registerTool(
    'append_daily_note',
    {
      description:
        'Create or append to the configured daily note without overwriting existing content.',
      inputSchema: {
        vault: z.string().min(1),
        content: z.string(),
        date: z.string().date().optional(),
      },
      annotations: closedWorldAnnotations,
    },
    async ({ vault, content, date }) =>
      runTool(
        async () =>
          context.dailyNotes.append(
            vault,
            content,
            date ? new Date(`${date}T00:00:00`) : new Date(),
          ),
        (data) => `Appended to ${data.path}`,
      ),
  );
}
