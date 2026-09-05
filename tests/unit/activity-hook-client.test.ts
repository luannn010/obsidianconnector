import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendActivitySpool,
  runActivityHook,
} from '../../src/activity/hook-client.js';

describe('agent activity hook client', () => {
  it('sends normalized metadata without preserving the submitted prompt', async () => {
    const bodies: string[] = [];
    const result = await runActivityHook({
      agent: 'codex',
      projectKey: 'MC-Platform',
      baseUrl: 'http://127.0.0.1:8765',
      token: 'token',
      input: {
        session_id: 'task-1',
        cwd: 'C:/repo',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Update observer grants\nprivate implementation detail',
      },
      fetchImpl: async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response(null, { status: 202 });
      },
      spool: async () => {
        throw new Error('should not spool');
      },
    });
    expect(result).toEqual({ blocked: false, refs: [], spooled: false });
    expect(bodies[0]).toContain('Update observer grants');
    expect(bodies[0]).not.toContain('private implementation detail');
  });

  it('spools normalized metadata when the loopback daemon is unavailable', async () => {
    const spooled: unknown[] = [];
    const result = await runActivityHook({
      agent: 'claude',
      projectKey: 'MC-Platform',
      baseUrl: 'http://127.0.0.1:8765',
      token: 'token',
      input: {
        session_id: 'task-2',
        cwd: 'C:/repo',
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_use_id: 'tool-1',
        tool_input: { file_path: 'C:/repo/src/index.ts' },
      },
      fetchImpl: async () => {
        throw new Error('offline');
      },
      spool: async (payload) => {
        spooled.push(payload);
      },
    });
    expect(result.spooled).toBe(true);
    expect(spooled).toEqual([
      expect.objectContaining({
        agent: 'claude',
        sessionId: 'task-2',
        events: [expect.objectContaining({ path: 'C:/repo/src/index.ts' })],
      }),
    ]);
  });

  it('returns a compact blocker only when the stop gate reports stale docs', async () => {
    const result = await runActivityHook({
      agent: 'codex',
      projectKey: 'MC-Platform',
      baseUrl: 'http://127.0.0.1:8765',
      token: 'token',
      input: {
        session_id: 'task-3',
        cwd: 'C:/repo',
        hook_event_name: 'Stop',
      },
      fetchImpl: async (url) =>
        String(url).includes('/gate')
          ? new Response(
              JSON.stringify({
                blocked: true,
                code: 'DOCS_STALE',
                refs: ['knowledge:item-1:v2'],
              }),
              { status: 409, headers: { 'content-type': 'application/json' } },
            )
          : new Response(null, { status: 202 }),
      spool: async () => undefined,
    });
    expect(result).toEqual({
      blocked: true,
      refs: ['knowledge:item-1:v2'],
      spooled: false,
    });
  });

  it('does not re-run the stop gate after Codex has already continued once', async () => {
    const urls: string[] = [];
    const result = await runActivityHook({
      agent: 'codex',
      projectKey: 'MC-Platform',
      baseUrl: 'http://127.0.0.1:8765',
      token: 'token',
      input: {
        session_id: 'task-3',
        cwd: 'C:/repo',
        hook_event_name: 'Stop',
        stop_hook_active: true,
      },
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response(null, { status: 202 });
      },
      spool: async () => undefined,
    });
    expect(result).toEqual({ blocked: false, refs: [], spooled: false });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/v1/activity');
  });

  it('bounds the outage spool by dropping its oldest complete records', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'activity-hook-spool-'));
    const spool = path.join(root, 'activity.ndjson');
    for (let index = 0; index < 8; index++)
      await appendActivitySpool(
        {
          projectKey: 'MC-Platform',
          agent: 'codex',
          sessionId: `task-${index}`,
          cwd: 'C:/repo',
          events: [],
        },
        spool,
        320,
      );
    const text = await readFile(spool, 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(320);
    expect(text).toContain('task-7');
    expect(text).not.toContain('task-0');
    expect(() =>
      text
        .split('\n')
        .filter(Boolean)
        .forEach((line) => JSON.parse(line)),
    ).not.toThrow();
  });
});
