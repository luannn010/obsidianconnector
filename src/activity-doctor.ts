import os from 'node:os';
import path from 'node:path';
import { resolveActivityProjectKey } from './activity/hook-client.js';
import type { ActivityStatus } from './activity/http-server.js';
import { loadDotEnv } from './config/registry.js';

loadDotEnv();
loadDotEnv(path.join(os.homedir(), '.codex', 'project-knowledge.env'));

const token = process.env.PROJECT_KNOWLEDGE_ACTIVITY_TOKEN?.trim();
const baseUrl = (
  process.env.PROJECT_KNOWLEDGE_ACTIVITY_BASE_URL?.trim() ||
  'http://127.0.0.1:8765'
).replace(/\/$/u, '');
const configuredProjectKey = await resolveActivityProjectKey(process.cwd());

console.log(`token: ${token ? 'present' : 'missing'}`);

let daemonReachable = false;
let status: ActivityStatus = {
  projectKey: null,
  lastEventAt: { claude: null, codex: null },
};

if (token) {
  const headers = { authorization: `Bearer ${token}` };
  try {
    const health = await fetch(`${baseUrl}/health`, {
      headers,
      signal: AbortSignal.timeout(1500),
    });
    daemonReachable = health.ok;
    if (daemonReachable) {
      const query = new URLSearchParams({ cwd: process.cwd() });
      if (configuredProjectKey) query.set('projectKey', configuredProjectKey);
      const response = await fetch(`${baseUrl}/v1/status?${query.toString()}`, {
        headers,
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) status = (await response.json()) as ActivityStatus;
    }
  } catch {
    daemonReachable = false;
  }
}

console.log(`daemon: ${daemonReachable ? 'reachable' : 'unreachable'}`);
console.log(`project: ${status.projectKey ?? 'unresolved'}`);
console.log(`last claude event: ${status.lastEventAt.claude ?? 'never'}`);
console.log(`last codex event: ${status.lastEventAt.codex ?? 'never'}`);

if (!token || !daemonReachable || !status.projectKey) process.exitCode = 1;
