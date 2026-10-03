import { createRequire } from 'node:module';

export type MetricsModule = typeof import('@mcp-dashboard/metrics');

export function loadMetricsModule(
  load: () => unknown = () => createRequire(import.meta.url)('@mcp-dashboard/metrics'),
): MetricsModule | null {
  try {
    return load() as MetricsModule;
  } catch {
    return null;
  }
}
