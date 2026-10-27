import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MetricsSink } from '@mcp-dashboard/metrics';
import { loadMetricsModule, type MetricsModule } from './metrics-loader.js';
import type { VaultRegistry } from './config/registry.js';
import { DailyNoteService } from './services/daily-note-service.js';
import { FilesystemService } from './services/filesystem-service.js';
import { FrontmatterService } from './services/frontmatter-service.js';
import { SearchService } from './services/search-service.js';
import { ProjectContextService } from './services/project-context-service.js';
import { ProjectBootstrapService } from './services/project-bootstrap-service.js';
import { ProjectMappingService } from './services/project-mapping-service.js';
import { registerDirectoryTools } from './tools/directory-tools.js';
import { registerFileTools } from './tools/file-tools.js';
import { registerObsidianTools } from './tools/obsidian-tools.js';
import { registerProjectTools } from './tools/project-tools.js';
import { registerVaultTools } from './tools/vault-tools.js';
import type { ToolContext } from './tools/tool-utils.js';
import type {
  KnowledgeStore,
  ProjectSyncActionRunner,
} from './knowledge/types.js';
import { registerKnowledgeTools } from './tools/knowledge-tools.js';
import { registerIdeaTools } from './tools/idea-tools.js';
import {
  IdeaWorkspace,
  type IdeaProjectResolver,
} from './ideas/idea-workspace.js';

export interface ServerOptions {
  profile?: 'standard' | 'admin';
  knowledge?: KnowledgeStore;
  syncActions?: ProjectSyncActionRunner;
  ideaProjects?: IdeaProjectResolver;
  metrics?: MetricsSink;
  metricsModule?: MetricsModule | null;
}

export function createServer(
  registry: VaultRegistry,
  options: ServerOptions = {},
): McpServer {
  const files = new FilesystemService(registry);
  const mapping = new ProjectMappingService(registry, files);
  const context: ToolContext = {
    registry,
    files,
    search: new SearchService(registry, files),
    frontmatter: new FrontmatterService(files),
    dailyNotes: new DailyNoteService(registry, files),
    project: new ProjectContextService(registry, files, mapping),
    bootstrap: new ProjectBootstrapService(registry, mapping, files),
  };
  const server = new McpServer({
    name: 'ObsidianConnector',
    version: '0.1.0',
  });
  if (options.metrics) {
    const metricsModule =
      options.metricsModule === undefined
        ? loadMetricsModule()
        : options.metricsModule;
    if (metricsModule) {
      metricsModule.instrumentServer(
        server,
        options.metrics,
        'obsidian-local',
        {
          extractProjectKey: metricsModule.stringField('projectKey'),
        },
      );
    }
  }
  if (options.profile === 'standard') {
    if (!options.knowledge) {
      throw new Error(
        'The standard profile requires a project knowledge store',
      );
    }
    registerKnowledgeTools(server, options.knowledge, options.syncActions);
    if (options.ideaProjects)
      registerIdeaTools(
        server,
        new IdeaWorkspace(
          registry,
          files,
          options.ideaProjects,
          options.knowledge,
        ),
      );
    return server;
  }
  registerVaultTools(server, context);
  registerDirectoryTools(server, context);
  registerFileTools(server, context);
  registerObsidianTools(server, context);
  registerProjectTools(server, context);
  return server;
}
