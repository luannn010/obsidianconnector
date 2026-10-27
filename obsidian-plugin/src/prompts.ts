// Pure builders for agent prompts, launch commands, and deep links.

import type { Card, PrototypeType } from './model';

export const CLAUDE_QUERY_LIMIT = 14000;
/** Leave headroom under Claude Desktop's ~14k cap for the encoded prompt. */
export const CLAUDE_QUERY_BUDGET = 8000;

const PROTOTYPE_DESCRIPTIONS: Record<PrototypeType, string> = {
  html: 'a self-contained clickable HTML prototype (inline CSS/JS, no external network calls) saved under `prototypes/*.html`',
  diagram:
    'a Mermaid diagram saved under `prototypes/*.mmd` (or an SVG under `prototypes/*.svg`)',
  spike:
    'a code spike on a new git branch in the repository; record the branch name as a `spike` artifact',
};

export interface PromptContext {
  card: Card;
  /** Card note body without frontmatter (Problem / Proposal / Acceptance criteria). */
  body: string;
  projectKey: string;
  repoPath: string;
  /** Absolute filesystem path of the card folder. */
  cardFolderAbs: string;
}

function joinPath(folder: string, child: string): string {
  const separator = folder.includes('\\') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${separator}${child.replace(/\//g, separator)}`;
}

export function buildPlanPrompt(context: PromptContext): string {
  const { card, body, projectKey, repoPath, cardFolderAbs } = context;
  const lines: string[] = [
    `# Plan idea card \`${card.slug}\``,
    '',
    `- Project key: \`${projectKey}\``,
    `- Repository: \`${repoPath}\``,
    `- Card folder: \`${cardFolderAbs}\``,
    `- Card note: \`${joinPath(cardFolderAbs, 'card.md')}\``,
    `- Priority: ${card.priority || 'unset'}`,
    '',
    '## Card',
    '',
    `### ${card.title}`,
    '',
    body.trim() || '_No card body._',
    '',
  ];
  if (card.reviewNote.trim()) {
    lines.push(
      '## Requested changes from the last plan review',
      '',
      card.reviewNote.trim(),
      '',
      'Revise the existing plan and prototypes to address this feedback.',
      '',
    );
  }
  lines.push('## Requested prototypes', '');
  if (card.prototypesRequested.length === 0) {
    lines.push('None. Produce the plan only.', '');
  } else {
    for (const type of card.prototypesRequested)
      lines.push(`- **${type}**: ${PROTOTYPE_DESCRIPTIONS[type]}`);
    lines.push('');
  }
  lines.push(
    '## Instructions',
    '',
    '1. Use the `project-to-obsidian` skill. Start with `get_project_sync_status`, then',
    `   \`recall_project_knowledge\` for project \`${projectKey}\` to get the context this card needs.`,
    '2. Read the repository code relevant to the card. Do not implement the feature.',
    '3. Write an implementation plan (goal, approach, files to change, steps, tests, risks)',
    `   and attach it with \`attach_card_artifact\` (project \`${projectKey}\`, card \`${card.slug}\`, type \`plan\`, path \`plan.md\`).`,
    '4. Build each requested prototype and attach it with `attach_card_artifact` using the',
    '   matching type (`html`, `diagram`, or `spike`). Paths are relative to the card folder.',
    `5. Finish with \`set_card_status\` (project \`${projectKey}\`, card \`${card.slug}\`, status \`plan-review\`).`,
    '',
  );
  return lines.join('\n');
}

export function buildBuildPrompt(context: PromptContext): string {
  const { card, body, projectKey, repoPath, cardFolderAbs } = context;
  return [
    `# Build idea card \`${card.slug}\``,
    '',
    `- Project key: \`${projectKey}\``,
    `- Repository: \`${repoPath}\``,
    `- Approved plan: \`${joinPath(cardFolderAbs, 'plan.md')}\``,
    `- Card note: \`${joinPath(cardFolderAbs, 'card.md')}\``,
    ...(card.spikeBranch
      ? [`- Spike branch for reference: \`${card.spikeBranch}\``]
      : []),
    '',
    '## Card',
    '',
    `### ${card.title}`,
    '',
    body.trim() || '_No card body._',
    '',
    '## Instructions',
    '',
    '1. Use the `project-to-obsidian` skill to recall project context before editing.',
    '2. Implement the approved plan in the repository. Prototypes under `prototypes/` are references, not production code.',
    '3. Meet every acceptance criterion and run the project checks (typecheck, lint, tests, build).',
    '4. Record decisions and gotchas with `write_project_knowledge`.',
    `5. When done, call \`set_card_status\` (project \`${projectKey}\`, card \`${card.slug}\`, status \`review\`).`,
    '',
  ].join('\n');
}

export function buildClaudeShortPrompt(
  card: Card,
  projectKey: string,
  cardFolderAbs: string,
): string {
  return [
    `Build idea card "${card.title}" (${card.slug}) for project ${projectKey}.`,
    `Read the approved plan at ${joinPath(cardFolderAbs, 'plan.md')} and follow the build instructions at ${joinPath(cardFolderAbs, 'prompts/build.md')}.`,
    `When done, move the card to review with set_card_status (project ${projectKey}, card ${card.slug}, status review).`,
  ].join('\n');
}

export function buildClaudeUrl(prompt: string, repoPath: string): string {
  let text = prompt;
  // Trim the prompt until the encoded query fits the budget.
  while (
    encodeURIComponent(text).length > CLAUDE_QUERY_BUDGET &&
    text.length > 0
  ) {
    text = text.slice(0, Math.floor(text.length * 0.9));
  }
  return `claude://code/new?q=${encodeURIComponent(text)}&folder=${encodeURIComponent(repoPath)}`;
}

export function buildCodexMessage(
  slug: string,
  projectKey: string,
  planPromptAbs: string,
): string {
  return `Plan idea card ${slug} for ${projectKey}; follow ${planPromptAbs}`;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  /** Pass args to the process untouched (cmd.exe quoting is done here). */
  verbatim: boolean;
}

/** Removes characters that cmd.exe could interpret as quoting, expansion, or redirection. */
export function sanitizeForCmd(text: string): string {
  return text
    .replace(/["%&|<>^\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cmdQuote(text: string): string {
  return `"${sanitizeForCmd(text)}"`;
}

/**
 * Windows Terminal: `wt.exe -d <repo> cmd.exe /k <codex> "<message>"`.
 * `cmd.exe /k` resolves npm `.cmd` shims and keeps the tab open after Codex exits.
 * `;` separates wt subcommands, so it is escaped as `\;`.
 */
export function buildTerminalLaunch(
  terminalCommand: string,
  codexCommand: string,
  repoPath: string,
  message: string,
): LaunchSpec {
  return {
    command: terminalCommand,
    args: [
      '-d',
      repoPath,
      'cmd.exe',
      '/k',
      codexCommand,
      sanitizeForCmd(message).replace(/;/g, '\\;'),
    ],
    verbatim: false,
  };
}

/**
 * Fallback without Windows Terminal: `cmd /c start "" /D <repo> cmd.exe /s /k ""<codex>" "<message>""`.
 * `/s` makes the inner cmd strip only the outer pair of quotes.
 */
export function buildCmdFallbackLaunch(
  codexCommand: string,
  repoPath: string,
  message: string,
): LaunchSpec {
  return {
    command: 'cmd.exe',
    args: [
      '/c',
      'start',
      '""',
      '/D',
      cmdQuote(repoPath),
      'cmd.exe',
      '/s',
      '/k',
      `"${cmdQuote(codexCommand)} ${cmdQuote(message)}"`,
    ],
    verbatim: true,
  };
}
