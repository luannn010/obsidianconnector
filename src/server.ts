import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultRegistry } from './config/registry.js';
import { DailyNoteService } from './services/daily-note-service.js';
import { FilesystemService } from './services/filesystem-service.js';
import { FrontmatterService } from './services/frontmatter-service.js';
import { SearchService } from './services/search-service.js';
import { registerDirectoryTools } from './tools/directory-tools.js';
import { registerFileTools } from './tools/file-tools.js';
import { registerObsidianTools } from './tools/obsidian-tools.js';
import { registerVaultTools } from './tools/vault-tools.js';
import type { ToolContext } from './tools/tool-utils.js';

export function createServer(registry: VaultRegistry): McpServer {
  const files = new FilesystemService(registry);
  const context: ToolContext = {
    registry,
    files,
    search: new SearchService(registry, files),
    frontmatter: new FrontmatterService(files),
    dailyNotes: new DailyNoteService(registry, files),
  };
  const server = new McpServer({
    name: 'ObsidianConnector',
    version: '0.1.0',
  });
  registerVaultTools(server, context);
  registerDirectoryTools(server, context);
  registerFileTools(server, context);
  registerObsidianTools(server, context);
  return server;
}
