import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeHookPayload,
  type ActivityAgent,
  type NormalizedHookPayload,
} from './hook-normalizer.js';

export interface ActivityHookResult {
  blocked: boolean;
  refs: string[];
  spooled: boolean;
}

export interface RunActivityHookOptions {
  agent: ActivityAgent;
  projectKey: string;
  baseUrl: string;
  token: string;
  input: unknown;
  fetchImpl?: typeof fetch;
  spool?: (
    payload: NormalizedHookPayload & { projectKey: string },
  ) => Promise<void>;
}

export async function appendActivitySpool(
  payload: NormalizedHookPayload & { projectKey: string },
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

export async function runActivityHook(
  options: RunActivityHookOptions,
): Promise<ActivityHookResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const spool = options.spool ?? appendActivitySpool;
  const normalized = {
    projectKey: options.projectKey,
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
  if (normalized.lifecycle !== 'stop' || normalized.stopHookActive)
    return { blocked: false, refs: [], spooled };
  try {
    const response = await fetchImpl(
      `${options.baseUrl.replace(/\/$/u, '')}/v1/tasks/${options.agent}/${encodeURIComponent(normalized.sessionId)}/gate?projectKey=${encodeURIComponent(options.projectKey)}`,
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
