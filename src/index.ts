import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getConfigPath, loadDotEnv, VaultRegistry } from './config/registry.js';
import { createServer } from './server.js';

export async function main(): Promise<void> {
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  loadDotEnv(path.join(projectRoot, '.env'));
  const registry = await VaultRegistry.load(
    getConfigPath({ cwd: projectRoot }),
  );
  const server = createServer(registry);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
