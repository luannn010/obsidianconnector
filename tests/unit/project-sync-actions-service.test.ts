import { describe, expect, it, vi } from 'vitest';
import type { FinalizeProjectionInput } from '../../src/knowledge/types.js';
import { ProjectSyncActionsService } from '../../src/services/project-sync-actions-service.js';

function input(
  overrides: Partial<FinalizeProjectionInput> = {},
): FinalizeProjectionInput {
  return {
    projectKey: 'Host-Mesh',
    worktreePath: 'D:/Host-Mesh',
    timeoutSeconds: 300,
    pollSeconds: 5,
    localEmbeddingFallback: false,
    ...overrides,
  };
}

describe('project sync action MCP service contract', () => {
  it('delegates FINALIZE_PROJECTION sync actions to projection finalization', async () => {
    const finalizeProjection = vi.fn(async () => ({
      projectKey: 'Host-Mesh',
      state: 'completed',
      dbRevision: 12,
    }));
    const service = {
      finalizeProjection,
      runProjectSyncAction: ProjectSyncActionsService.prototype.runProjectSyncAction,
    } as unknown as ProjectSyncActionsService;

    const result = await service.runProjectSyncAction({
      ...input(),
      action: 'FINALIZE_PROJECTION',
    });

    expect(result).toMatchObject({ state: 'completed', dbRevision: 12 });
    expect(finalizeProjection).toHaveBeenCalledWith({
      ...input(),
      action: 'FINALIZE_PROJECTION',
    });
  });
});
