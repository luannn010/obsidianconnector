import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendActivitySpool,
  formatHandoffContext,
  resolveActivityProjectKey,
  runActivityHook,
} from '../../src/activity/hook-client.js';

describe('agent activity hook client', () => {
  it('resolves the project key from the environment before repository config', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'activity-hook-key-'));
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, '.obsidian-local'));
    await writeFile(
      path.join(root, '.obsidian-local', 'config.json'),
      JSON.stringify({ projectKey: 'Config-Project' }),
    );

    await expect(
      resolveActivityProjectKey(root, {
        PROJECT_KNOWLEDGE_PROJECT_KEY: ' Env-Project ',
      }),
    ).resolves.toBe('Env-Project');
  });

  it('resolves the project key from the git root config for a nested cwd', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'activity-hook-key-'));
    const cwd = path.join(root, 'src', 'nested');
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, '.obsidian-local'));
    await mkdir(cwd, { recursive: true });
    await writeFile(
      path.join(root, '.obsidian-local', 'config.json'),
      JSON.stringify({ projectKey: 'Config-Project' }),
    );

    await expect(resolveActivityProjectKey(cwd, {})).resolves.toBe(
      'Config-Project',
    );
  });

  it('omits the project key when neither environment nor git config provides one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'activity-hook-key-'));
    const bodies: Array<Record<string, unknown>> = [];
    await runActivityHook({
      agent: 'codex',
      baseUrl: 'http://127.0.0.1:8765',
      token: 'token',
      input: { session_id: 'task-0', cwd: root },
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(null, { status: 202 });
      },
      spool: async () => undefined,
    });

    expect(bodies[0]).not.toHaveProperty('projectKey');
  });

  it('sends normalized metadata without preserving the submitted prompt', async () => {
    const bodies: string[] = [];
    const result = await runActivityHook({
      agent: 'codex',
      projectKey: 'Test-Project',
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
      projectKey: 'Test-Project',
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
      projectKey: 'Test-Project',
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
      projectKey: 'Test-Project',
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

  it('injects the other agent handoff as context on session start', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const result = await runActivityHook({
      agent: 'claude',
      projectKey: 'Obsidian-Connector',
      baseUrl: 'http://127.0.0.1:8765',
      token: 'token',
      input: {
        session_id: 'claude-1',
        cwd: 'C:/repo',
        hook_event_name: 'SessionStart',
      },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: init?.body as string });
        if (String(url).endsWith('/v1/handoff'))
          return Response.json({
            tasks: [
              {
                agent: 'codex',
                taskName: 'Add metrics loader',
                status: 'completed',
                lastSeenAt: '2026-10-27T01:00:00.000Z',
                branch: 'feat/mcp-metrics',
                changedFiles: ['src/metrics-loader.ts'],
                moreFiles: 0,
                staleRefs: ['knowledge:item-1:v2'],
              },
            ],
            blockers: ['Embedding worker heartbeat stale'],
          });
        return new Response(null, { status: 202 });
      },
      spool: async () => undefined,
    });
    expect(calls[1]?.url).toBe('http://127.0.0.1:8765/v1/handoff');
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      projectKey: 'Obsidian-Connector',
      agent: 'claude',
      cwd: 'C:/repo',
    });
    expect(result.context).toContain('Add metrics loader');
    expect(result.context).toContain('src/metrics-loader.ts');
    expect(result.context).toContain('knowledge:item-1:v2');
    expect(result.context).toContain('Embedding worker heartbeat stale');
  });

  it('skips the handoff when the daemon fails or nothing is pending', async () => {
    const result = await runActivityHook({
      agent: 'codex',
      projectKey: 'Obsidian-Connector',
      baseUrl: 'http://127.0.0.1:8765',
      token: 'token',
      input: {
        session_id: 'c-1',
        cwd: 'C:/repo',
        hook_event_name: 'SessionStart',
      },
      fetchImpl: async (url) =>
        String(url).endsWith('/v1/handoff')
          ? new Response(null, { status: 500 })
          : new Response(null, { status: 202 }),
      spool: async () => undefined,
    });
    expect(result).toEqual({ blocked: false, refs: [], spooled: false });
    expect(formatHandoffContext({ tasks: [], blockers: [] })).toBeUndefined();
  });

  it('keeps the handoff context within its character budget', () => {
    const context = formatHandoffContext({
      tasks: Array.from({ length: 3 }, (_, index) => ({
        agent: 'codex' as const,
        taskName: `Task ${index} ${'x'.repeat(200)}`,
        status: 'active',
        lastSeenAt: '2026-10-27T01:00:00.000Z',
        changedFiles: Array.from(
          { length: 8 },
          (_, file) => `src/${'y'.repeat(80)}-${file}.ts`,
        ),
        moreFiles: 12,
        staleRefs: [],
      })),
      blockers: [],
    });
    expect(context!.length).toBeLessThanOrEqual(1600);
    expect(context).toContain('+12 more');
  });

  it('strips markup from prompt-derived task names', () => {
    const context = formatHandoffContext({
      tasks: [
        {
          agent: 'claude',
          taskName: '<pasted_content id="48d9">',
          status: 'completed',
          lastSeenAt: '2026-10-27T01:00:00.000Z',
          changedFiles: ['src/a.ts'],
          moreFiles: 0,
          staleRefs: [],
        },
      ],
      blockers: [],
    });
    expect(context).toContain(']: Untitled task');
    expect(context).not.toContain('pasted_content');
  });

  it('bounds the outage spool by dropping its oldest complete records', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'activity-hook-spool-'));
    const spool = path.join(root, 'activity.ndjson');
    for (let index = 0; index < 8; index++)
      await appendActivitySpool(
        {
          projectKey: 'Test-Project',
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
