import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { IdeaError } from '../ideas/errors.js';
import {
  ARTIFACT_TYPES,
  CARD_PRIORITIES,
  CARD_STATUSES,
  PROTOTYPE_TYPES,
} from '../ideas/idea-cards.js';
import type { IdeaWorkspace } from '../ideas/idea-workspace.js';
import { runTool, toolSuccess } from './tool-utils.js';

const projectKey = z.string();
const slug = z.string().describe('Card folder name under Board/Cards');
const actor = z
  .string()
  .optional()
  .describe('Who made the change, for example codex, claude, or user');

async function runIdeaTool<T extends object>(
  operation: () => Promise<T>,
  summary: (data: T) => string,
): Promise<CallToolResult> {
  try {
    const data = await operation();
    return toolSuccess(data, summary(data));
  } catch (error) {
    if (error instanceof IdeaError)
      return {
        isError: true,
        content: [{ type: 'text', text: error.message }],
      };
    return runTool(
      () => Promise.reject(error),
      () => '',
    );
  }
}

export function registerIdeaTools(
  server: McpServer,
  ideas: IdeaWorkspace,
): void {
  server.registerTool(
    'list_project_ideas',
    {
      description:
        "List the untriaged ideas in a project's Ideas.md. Each idea has a stable ref to pass to create_idea_cards.",
      inputSchema: { projectKey },
      annotations: { openWorldHint: false, readOnlyHint: true },
    },
    async (input) =>
      runIdeaTool(
        () => ideas.listIdeas(input),
        (data) =>
          `${data.ideas.length} untriaged ideas in ${data.vault}/${data.ideasPath}`,
      ),
  );

  server.registerTool(
    'create_idea_cards',
    {
      description:
        'Turn triaged ideas into Backlog cards on the project board (Board/Cards/<slug>/card.md) and link each source bullet to its card. A card may merge several ideaRefs. Replays with the same idea and title return the existing card.',
      inputSchema: {
        projectKey,
        idempotencyKey: z.string().min(1),
        actor,
        cards: z
          .array(
            z.object({
              ideaRefs: z.array(z.string()).min(1),
              title: z.string().min(1).max(120),
              priority: z.enum(CARD_PRIORITIES).optional(),
              problem: z.string().min(1),
              proposal: z.string().min(1),
              acceptance: z.array(z.string().min(1)).min(1),
              prototypes: z.array(z.enum(PROTOTYPE_TYPES)).optional(),
            }),
          )
          .min(1)
          .max(25),
      },
    },
    async (input) =>
      runIdeaTool(
        () => ideas.createCards(input),
        (data) =>
          `${data.cards.filter((card) => card.outcome === 'created').length} cards created, ${data.triagedIdeas.length} ideas linked`,
      ),
  );

  server.registerTool(
    'attach_card_artifact',
    {
      description:
        'Attach a plan or prototype to a card. plan writes plan.md; html writes a self-contained prototypes/<title>.html (no external network); diagram writes Mermaid (.mmd) or SVG; spike records a git branch. Content is limited to 2 MB.',
      inputSchema: {
        projectKey,
        slug,
        type: z.enum(ARTIFACT_TYPES),
        title: z.string().min(1).max(120),
        content: z.string().optional(),
        branch: z.string().optional(),
        diagramFormat: z.enum(['mermaid', 'svg']).optional(),
      },
    },
    async (input) =>
      runIdeaTool(
        () => ideas.attachArtifact(input),
        (data) =>
          `Attached ${data.artifact.type} "${data.artifact.title}" to ${data.slug}`,
      ),
  );

  server.registerTool(
    'set_card_status',
    {
      description:
        'Move a board card to another column. A note is saved as review_note (use it for change requests); moving to ready clears the note.',
      inputSchema: {
        projectKey,
        slug,
        status: z.enum(CARD_STATUSES),
        note: z.string().optional(),
        actor,
      },
    },
    async (input) =>
      runIdeaTool(
        () => ideas.setStatus(input),
        (data) => `${data.slug}: ${data.from} -> ${data.to}`,
      ),
  );
}
