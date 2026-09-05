import { loadDotEnv } from './config/registry.js';
import os from 'node:os';
import path from 'node:path';
import { runActivityHook } from './activity/hook-client.js';
import type { ActivityAgent } from './activity/hook-normalizer.js';

loadDotEnv();
loadDotEnv(path.join(os.homedir(), '.codex', 'project-knowledge.env'));

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function argument(name: string): string | undefined {
  const direct = process.argv.find((value) => value.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const agent = argument('--agent') as ActivityAgent | undefined;
if (agent !== 'codex' && agent !== 'claude') process.exit(0);
const token = process.env.PROJECT_KNOWLEDGE_ACTIVITY_TOKEN?.trim();
if (!token) process.exit(0);

try {
  const raw = await readStdin();
  const input = raw.trim() ? (JSON.parse(raw) as unknown) : {};
  const result = await runActivityHook({
    agent,
    projectKey:
      process.env.PROJECT_KNOWLEDGE_PROJECT_KEY?.trim() || 'MC-Platform',
    baseUrl:
      process.env.PROJECT_KNOWLEDGE_ACTIVITY_BASE_URL?.trim() ||
      'http://127.0.0.1:8765',
    token,
    input,
  });
  if (result.blocked) {
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: `Required documentation is stale: ${result.refs.join(', ')}`,
      }),
    );
  }
} catch {
  process.exitCode = 0;
}
