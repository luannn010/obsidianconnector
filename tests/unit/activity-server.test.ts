import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createActivityHttpServer,
  type ActivityRequestHandler,
} from '../../src/activity/http-server.js';

describe('activity loopback HTTP server', () => {
  const servers: Array<ReturnType<typeof createActivityHttpServer>> = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
  });

  async function start(handler: ActivityRequestHandler) {
    const server = createActivityHttpServer({ token: 'local-token', handler });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    return `http://127.0.0.1:${address.port}`;
  }

  it('rejects requests without the local bearer token', async () => {
    const baseUrl = await start({
      record: async () => ({ accepted: 0, ignored: 0 }),
      gate: async () => ({ blocked: false, refs: [] }),
    });
    const response = await fetch(`${baseUrl}/v1/activity`, {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(401);
  });

  it('accepts a normalized activity batch without returning model context', async () => {
    const received: unknown[] = [];
    const baseUrl = await start({
      record: async (payload) => {
        received.push(payload);
        return { accepted: 1, ignored: 0 };
      },
      gate: async () => ({ blocked: false, refs: [] }),
    });
    const response = await fetch(`${baseUrl}/v1/activity`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ agent: 'codex', sessionId: 'task-1' }),
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    expect(received).toHaveLength(1);
  });

  it('returns compact stale documentation refs from the task gate', async () => {
    const baseUrl = await start({
      record: async () => ({ accepted: 0, ignored: 0 }),
      gate: async () => ({
        blocked: true,
        refs: ['knowledge:item-1:v2'],
      }),
    });
    const response = await fetch(
      `${baseUrl}/v1/tasks/codex/task-1/gate?projectKey=MC-Platform`,
      { headers: { authorization: 'Bearer local-token' } },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      blocked: true,
      code: 'DOCS_STALE',
      refs: ['knowledge:item-1:v2'],
    });
  });
});
