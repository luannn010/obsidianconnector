import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getConfigPath, loadDotEnv, VaultRegistry } from './config/registry.js';
import { createServer } from './server.js';

export async function main(): Promise<void> {
  loadDotEnv();
  const registry = await VaultRegistry.load(getConfigPath());
  const server = createServer(registry);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
