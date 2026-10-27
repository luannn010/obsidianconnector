import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeHookPayload,
  type ActivityAgent,
  type NormalizedHookPayload,
} from './hook-normalizer.js';
import type { ActivityHandoff } from './http-server.js';

export interface ActivityHookResult {
  blocked: boolean;
  refs: string[];
  spooled: boolean;
  context?: string;
}

const HANDOFF_CONTEXT_LIMIT = 1600;

export function formatHandoffContext(
  handoff: ActivityHandoff,
): string | undefined {
  if (!handoff.tasks.length && !handoff.blockers.length) return undefined;
  const lines = ['Cross-agent handoff (project knowledge activity):'];
  for (const task of handoff.tasks) {
    const branch = task.branch ? ` on ${task.branch}` : '';
    const name =
      task.taskName.replace(/<[^>]*>/gu, '').trim() || 'Untitled task';
    lines.push(
      `- ${task.agent} [${task.status}, ${task.lastSeenAt.slice(0, 16).replace('T', ' ')}Z${branch}]: ${name.slice(0, 100)}`,
    );
    if (task.changedFiles.length) {
      const more = task.moreFiles ? ` (+${task.moreFiles} more)` : '';
      lines.push(`  changed: ${task.changedFiles.join(', ')}${more}`);
    }
    if (task.staleRefs.length)
      lines.push(`  stale docs: ${task.staleRefs.join(', ')}`);
  }
  if (handoff.blockers.length)
    lines.push(`Open blockers: ${handoff.blockers.join('; ')}`);
  lines.push(
    'Call recall_project_knowledge (intent catch_up) before changing these files.',
  );
  const text = lines.join('\n');
  return text.length <= HANDOFF_CONTEXT_LIMIT
    ? text
    : `${text.slice(0, HANDOFF_CONTEXT_LIMIT - 1)}…`;
}

export interface RunActivityHookOptions {
  agent: ActivityAgent;
  projectKey?: string;
  baseUrl: string;
  token: string;
  input: unknown;
  fetchImpl?: typeof fetch;
  spool?: (
    payload: NormalizedHookPayload & { projectKey?: string },
  ) => Promise<void>;
}

export async function resolveActivityProjectKey(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const configured = env.PROJECT_KNOWLEDGE_PROJECT_KEY?.trim();
  if (configured) return configured;

  let current = path.resolve(cwd);
  while (true) {
    try {
      await stat(path.join(current, '.git'));
      try {
        const parsed = JSON.parse(
          await readFile(
            path.join(current, '.obsidian-local', 'config.json'),
            'utf8',
          ),
        ) as { projectKey?: unknown };
        return typeof parsed.projectKey === 'string' && parsed.projectKey.trim()
          ? parsed.projectKey.trim()
          : undefined;
      } catch {
        return undefined;
      }
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

export async function appendActivitySpool(
  payload: NormalizedHookPayload & { projectKey?: string },
  spoolPath = process.env.PROJECT_KNOWLEDGE_ACTIVITY_SPOOL?.trim() ||
    path.join(
      os.homedir(),
      '.codex',
      'project-knowledge',
      'activity-spool.ndjson',
    ),
  maxBytes = 5 * 1024 * 1024,
): Promise<void> {
  await mkdir(path.dirname(spoolPath), { recursive: true });
  await appendFile(spoolPath, `${JSON.stringify(payload)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  const content = await readFile(spoolPath, 'utf8');
  if (Buffer.byteLength(content) <= maxBytes) return;
  const retained: string[] = [];
  let retainedBytes = 0;
  for (const line of content.split(/\r?\n/u).filter(Boolean).reverse()) {
    const lineBytes = Buffer.byteLength(`${line}\n`);
    if (retainedBytes + lineBytes > maxBytes) break;
    retained.push(line);
    retainedBytes += lineBytes;
  }
  await writeFile(
    spoolPath,
    retained.length ? `${retained.reverse().join('\n')}\n` : '',
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function fetchHandoffContext(
  options: RunActivityHookOptions,
  cwd: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(
      `${options.baseUrl.replace(/\/$/u, '')}/v1/handoff`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...(options.projectKey ? { projectKey: options.projectKey } : {}),
          agent: options.agent,
          cwd,
        }),
        signal: AbortSignal.timeout(1200),
      },
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as Partial<ActivityHandoff>;
    return formatHandoffContext({
      tasks: Array.isArray(body.tasks) ? body.tasks.slice(0, 3) : [],
      blockers: Array.isArray(body.blockers) ? body.blockers.slice(0, 3) : [],
    });
  } catch {
    return undefined;
  }
}

export async function runActivityHook(
  options: RunActivityHookOptions,
): Promise<ActivityHookResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const spool = options.spool ?? appendActivitySpool;
  const normalized = {
    ...(options.projectKey ? { projectKey: options.projectKey } : {}),
    ...normalizeHookPayload(options.agent, options.input),
  };
  const headers = {
    authorization: `Bearer ${options.token}`,
    'content-type': 'application/json',
  };
  let spooled = false;
  try {
    const response = await fetchImpl(
      `${options.baseUrl.replace(/\/$/u, '')}/v1/activity`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(normalized),
        signal: AbortSignal.timeout(750),
      },
    );
    if (!response.ok)
      throw new Error(`activity endpoint returned ${response.status}`);
  } catch {
    await spool(normalized);
    spooled = true;
  }
  if (normalized.lifecycle === 'session_start') {
    const context = spooled
      ? undefined
      : await fetchHandoffContext(options, normalized.cwd, fetchImpl, headers);
    return context
      ? { blocked: false, refs: [], spooled, context }
      : { blocked: false, refs: [], spooled };
  }
  if (normalized.lifecycle !== 'stop' || normalized.stopHookActive)
    return { blocked: false, refs: [], spooled };
  try {
    const query = new URLSearchParams({ cwd: normalized.cwd });
    if (options.projectKey) query.set('projectKey', options.projectKey);
    const response = await fetchImpl(
      `${options.baseUrl.replace(/\/$/u, '')}/v1/tasks/${options.agent}/${encodeURIComponent(normalized.sessionId)}/gate?${query.toString()}`,
      { headers, signal: AbortSignal.timeout(1500) },
    );
    if (response.status !== 409) return { blocked: false, refs: [], spooled };
    const body = (await response.json()) as { refs?: unknown };
    const refs = Array.isArray(body.refs)
      ? body.refs
          .filter((ref): ref is string => typeof ref === 'string')
          .slice(0, 20)
      : [];
    return { blocked: true, refs, spooled };
  } catch {
    return { blocked: false, refs: [], spooled };
  }
}
