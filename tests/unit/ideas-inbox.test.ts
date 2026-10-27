import { describe, expect, it } from 'vitest';
import { markIdeasTriaged, parseIdeas } from '../../src/ideas/ideas-inbox.js';

describe('ideas inbox', () => {
  it('parses top-level bullets, joins indented details, and ignores frontmatter and triaged ideas', () => {
    const content = [
      '---',
      'aliases:',
      '  - Not an idea',
      '---',
      '- First idea',
      '  - first detail',
      '  another detail',
      '* Second idea',
      '- Already done → [[Board/Cards/done/card|Done]] ^idea-deadbeef',
    ].join('\n');

    const ideas = parseIdeas(content);

    expect(ideas).toHaveLength(2);
    expect(ideas.map(({ text, line }) => ({ text, line }))).toEqual([
      { text: 'First idea\nfirst detail\nanother detail', line: 5 },
      { text: 'Second idea', line: 8 },
    ]);
  });

  it('keeps generated refs stable and honors an existing block id with CRLF input', () => {
    const content = '- Stable idea\r\n* Explicit ref ^idea-abc123\r\n';

    const first = parseIdeas(content);
    const second = parseIdeas(content);

    expect(first).toEqual(second);
    expect(first[0]?.ref).toMatch(/^idea-[a-f0-9]{8}$/u);
    expect(first[1]).toMatchObject({
      ref: 'idea-abc123',
      text: 'Explicit ref',
    });
  });

  it('marks selected ideas with card links, preserves CRLF, and makes them no longer parseable', () => {
    const content = '- Keep pending\r\n- Ship feature\r\n  - With detail\r\n';
    const selected = parseIdeas(content)[1]!;

    const marked = markIdeasTriaged(
      content,
      new Map([
        [selected.ref, { slug: 'ship-feature', title: '[ ] | Ship feature' }],
      ]),
    );

    expect(marked.marked).toEqual([selected.ref]);
    expect(marked.content).toContain(
      `- Ship feature → [[Board/Cards/ship-feature/card|   Ship feature]] ^${selected.ref}`,
    );
    expect(marked.content).toContain('\r\n');
    expect(marked.content.replaceAll('\r\n', '')).not.toContain('\n');
    expect(parseIdeas(marked.content).map((idea) => idea.text)).toEqual([
      'Keep pending',
    ]);

    const replay = markIdeasTriaged(
      marked.content,
      new Map([
        [selected.ref, { slug: 'ship-feature', title: 'Ship feature' }],
      ]),
    );
    expect(replay).toEqual({ content: marked.content, marked: [] });
  });
});
