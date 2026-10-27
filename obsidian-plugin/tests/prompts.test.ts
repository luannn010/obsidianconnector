import { describe, expect, it } from 'vitest';
import { parseCard } from '../src/model';
import {
  CLAUDE_QUERY_LIMIT,
  buildBuildPrompt,
  buildClaudeShortPrompt,
  buildClaudeUrl,
  buildCmdFallbackLaunch,
  buildCodexMessage,
  buildPlanPrompt,
  buildTerminalLaunch,
  sanitizeForCmd,
} from '../src/prompts';

const card = parseCard('Board/Cards/dark-mode/card.md', {
  card: true,
  title: 'Dark mode',
  status: 'planning',
  prototypes_requested: ['html', 'spike'],
  review_note: 'Cover the settings page too.',
})!;

const context = {
  card,
  body: '## Problem\nToo bright.\n\n## Acceptance criteria\n- Toggle exists',
  projectKey: 'lunar',
  repoPath: 'C:\\Repos\\Lunar',
  cardFolderAbs: 'G:\\My Drive\\.obsidian\\Lunar\\Board\\Cards\\dark-mode',
};

describe('plan prompt', () => {
  it('includes card body, requested prototypes, review note, and the MCP workflow', () => {
    const prompt = buildPlanPrompt(context);
    expect(prompt).toContain('Too bright.');
    expect(prompt).toContain('**html**');
    expect(prompt).toContain('**spike**');
    expect(prompt).not.toContain('**diagram**');
    expect(prompt).toContain('Cover the settings page too.');
    expect(prompt).toContain('project-to-obsidian');
    expect(prompt).toContain('attach_card_artifact');
    expect(prompt).toContain('`set_card_status`');
    expect(prompt).toContain('`plan-review`');
    expect(prompt).toContain(
      'G:\\My Drive\\.obsidian\\Lunar\\Board\\Cards\\dark-mode\\card.md',
    );
  });

  it('omits the review section when there is no note', () => {
    const prompt = buildPlanPrompt({
      ...context,
      card: { ...card, reviewNote: '', prototypesRequested: [] },
    });
    expect(prompt).not.toContain('Requested changes');
    expect(prompt).toContain('Produce the plan only.');
  });
});

describe('build prompt and Claude link', () => {
  it('points at plan.md and finishes with review status', () => {
    const prompt = buildBuildPrompt(context);
    expect(prompt).toContain('dark-mode\\plan.md');
    expect(prompt).toContain('status `review`');
  });

  it('builds a claude:// deep link with encoded prompt and folder', () => {
    const short = buildClaudeShortPrompt(card, 'lunar', context.cardFolderAbs);
    expect(short).toContain('prompts\\build.md');
    expect(short).toContain('set_card_status');
    const url = buildClaudeUrl(short, context.repoPath);
    expect(url.startsWith('claude://code/new?q=')).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('q')).toBe(short);
    expect(parsed.searchParams.get('folder')).toBe('C:\\Repos\\Lunar');
  });

  it('keeps q well under the Claude Desktop cap', () => {
    const url = buildClaudeUrl('é'.repeat(20000), 'C:\\Repos');
    const q = /\?q=([^&]*)/.exec(url)![1]!;
    expect(q.length).toBeLessThan(CLAUDE_QUERY_LIMIT / 1.5);
  });
});

describe('codex launch', () => {
  const message = buildCodexMessage(
    'dark-mode',
    'lunar',
    'G:\\Vault\\prompts\\plan.md',
  );

  it('builds the codex message', () => {
    expect(message).toBe(
      'Plan idea card dark-mode for lunar; follow G:\\Vault\\prompts\\plan.md',
    );
  });

  it('passes args as an array to wt and escapes subcommand separators', () => {
    const spec = buildTerminalLaunch(
      'wt.exe',
      'codex',
      'C:\\Repos\\Lunar',
      message,
    );
    expect(spec).toEqual({
      command: 'wt.exe',
      args: [
        '-d',
        'C:\\Repos\\Lunar',
        'cmd.exe',
        '/k',
        'codex',
        'Plan idea card dark-mode for lunar\\; follow G:\\Vault\\prompts\\plan.md',
      ],
      verbatim: false,
    });
  });

  it('builds a quoted cmd start fallback and strips cmd metacharacters', () => {
    const spec = buildCmdFallbackLaunch(
      'codex',
      'C:\\My Repos\\Lunar',
      'Plan x & del "y" %PATH%',
    );
    expect(spec.command).toBe('cmd.exe');
    expect(spec.verbatim).toBe(true);
    expect(spec.args).toEqual([
      '/c',
      'start',
      '""',
      '/D',
      '"C:\\My Repos\\Lunar"',
      'cmd.exe',
      '/s',
      '/k',
      '""codex" "Plan x del y PATH""',
    ]);
    expect(sanitizeForCmd('a|b>c<d^e')).toBe('a b c d e');
  });
});
