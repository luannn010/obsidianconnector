import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

export interface ActivityRequestHandler {
  record(payload: unknown): Promise<{ accepted: number; ignored: number }>;
  gate(input: {
    projectKey?: string;
    agent: string;
    sessionId: string;
    cwd?: string;
  }): Promise<{ blocked: boolean; refs: string[] }>;
  handoff?(input: {
    projectKey?: string;
    agent: string;
    cwd: string;
  }): Promise<ActivityHandoff>;
  status?(input: { cwd: string; projectKey?: string }): Promise<ActivityStatus>;
}

export interface ActivityHandoffTask {
  agent: 'codex' | 'claude';
  taskName: string;
  status: string;
  lastSeenAt: string;
  branch?: string;
  changedFiles: string[];
  moreFiles: number;
  staleRefs: string[];
}

export interface ActivityHandoff {
  tasks: ActivityHandoffTask[];
  blockers: string[];
}

export interface ActivityStatus {
  projectKey: string | null;
  lastEventAt: {
    claude: string | null;
    codex: string | null;
  };
}

export interface ActivityHttpServerOptions {
  token: string;
  handler: ActivityRequestHandler;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error('Activity request is too large');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

export function createActivityHttpServer(options: ActivityHttpServerOptions) {
  return createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${options.token}`) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, { ready: true });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/activity') {
        await options.handler.record(await readJson(request));
        response.statusCode = 202;
        response.end();
        return;
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/v1/handoff' &&
        options.handler.handoff
      ) {
        const body = (await readJson(request)) as Record<string, unknown>;
        if (
          (body.agent !== 'codex' && body.agent !== 'claude') ||
          typeof body.cwd !== 'string' ||
          !body.cwd.trim()
        )
          throw new Error('Invalid handoff request');
        json(
          response,
          200,
          await options.handler.handoff({
            ...(typeof body.projectKey === 'string' && body.projectKey.trim()
              ? { projectKey: body.projectKey.trim() }
              : {}),
            agent: body.agent,
            cwd: body.cwd,
          }),
        );
        return;
      }
      const gate = url.pathname.match(
        /^\/v1\/tasks\/(codex|claude)\/([^/]+)\/gate$/u,
      );
      if (request.method === 'GET' && gate) {
        const projectKey = url.searchParams.get('projectKey')?.trim();
        const cwd = url.searchParams.get('cwd')?.trim();
        const result = await options.handler.gate({
          ...(projectKey ? { projectKey } : {}),
          agent: gate[1]!,
          sessionId: decodeURIComponent(gate[2]!),
          ...(cwd ? { cwd } : {}),
        });
        if (result.blocked) {
          json(response, 409, {
            blocked: true,
            code: 'DOCS_STALE',
            refs: result.refs.slice(0, 20),
          });
        } else json(response, 200, { blocked: false, refs: [] });
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/v1/status' &&
        options.handler.status
      ) {
        const cwd = url.searchParams.get('cwd')?.trim();
        if (!cwd) throw new Error('Invalid status request');
        const projectKey = url.searchParams.get('projectKey')?.trim();
        json(
          response,
          200,
          await options.handler.status({
            cwd,
            ...(projectKey ? { projectKey } : {}),
          }),
        );
        return;
      }
      json(response, 404, { error: 'not_found' });
    } catch {
      json(response, 400, { error: 'invalid_request' });
    }
  });
}
