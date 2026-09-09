import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

export interface ActivityRequestHandler {
  record(payload: unknown): Promise<{ accepted: number; ignored: number }>;
  gate(input: {
    projectKey: string;
    agent: string;
    sessionId: string;
  }): Promise<{ blocked: boolean; refs: string[] }>;
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
      const gate = url.pathname.match(
        /^\/v1\/tasks\/(codex|claude)\/([^/]+)\/gate$/u,
      );
      if (request.method === 'GET' && gate) {
        const result = await options.handler.gate({
          projectKey: url.searchParams.get('projectKey') ?? 'MC-Platform',
          agent: gate[1]!,
          sessionId: decodeURIComponent(gate[2]!),
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
      json(response, 404, { error: 'not_found' });
    } catch {
      json(response, 400, { error: 'invalid_request' });
    }
  });
}
