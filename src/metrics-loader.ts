import { createRequire } from 'node:module';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// The optional host package owns the sink. The connector only passes it back
// to that package, so building must not depend on a workstation-local import.
export type MetricsSink = object;
export interface MetricsModule {
  createMetricsRecorder(options: {
    server: string;
    databaseUrl?: string;
  }): MetricsSink;
  instrumentServer(
    server: McpServer,
    sink: MetricsSink,
    name: string,
    options: { extractProjectKey: (args: unknown) => string | undefined },
  ): void;
  stringField(name: string): (args: unknown) => string | undefined;
}

export function loadMetricsModule(
  load: () => unknown = () =>
    createRequire(import.meta.url)('@mcp-dashboard/metrics'),
): MetricsModule | null {
  try {
    return load() as MetricsModule;
  } catch {
    return null;
  }
}
