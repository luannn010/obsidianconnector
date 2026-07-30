import { describe, expect, it } from 'vitest';
import { toolFailure } from '../../src/tools/tool-utils.js';

describe('MCP error sanitization', () => {
  it('does not expose local paths from filesystem errors', () => {
    const error = Object.assign(
      new Error(
        "ENOENT: no such file or directory, open 'C:\\Users\\secret\\vault\\note.md'",
      ),
      { code: 'ENOENT' },
    );

    const result = toolFailure(error);

    expect(result.content?.[0]).toEqual({
      type: 'text',
      text: 'Requested path does not exist',
    });
    expect(JSON.stringify(result)).not.toContain('C:\\Users\\secret');
  });
});
