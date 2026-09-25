import { describe, expect, it } from 'vitest';
import {
  buildLazyProjectViews,
  worktreeFolderName,
  type LazyProjectViewData,
} from '../../src/worker/lazy-project-views.js';

function fixture(): LazyProjectViewData {
  return {
    projectId: 'project-1',
    projectKey: 'MC-Platform',
    dbRevision: 12,
    generatedAt: '2026-09-25T00:00:00.000Z',
    failedJobs: 1,
    projectionConflicts: 0,
    staleEvidence: 2,
    worktrees: [
      {
        id: '24ce84ef-8462-474d-91f2-ef30d4ed7b02',
        path: 'C:/MC-Platform',
        branch: 'master',
        head: 'abcdef0123456789',
        dirty: true,
        dirtyPathCount: 4,
        snapshotId: 'snapshot-1',
        snapshotFresh: true,
        lastSeenAt: '2026-09-25T00:00:00.000Z',
      },
      {
        id: '8258afc1-5187-4c66-8b29-ae850e64d236',
        path: 'C:/MC-Platform/.worktrees/deploy',
        branch: 'ptolemy/deploy/pipeline',
        head: '1234567890abcdef',
        dirty: false,
        dirtyPathCount: 0,
        snapshotFresh: false,
        lastSeenAt: '2026-09-24T00:00:00.000Z',
      },
    ],
    tasks: [
      {
        id: 'task-1',
        worktreeId: '24ce84ef-8462-474d-91f2-ef30d4ed7b02',
        name: 'Complete the billing rollout',
        status: 'active',
        lastSeenAt: '2026-09-25T00:00:00.000Z',
      },
    ],
    workItems: [
      {
        title: 'Billing rollout',
        status: 'blocked',
        verificationStatus: 'unverified',
        blocker: 'Credential rotation is incomplete',
        worktreeIds: ['24ce84ef-8462-474d-91f2-ef30d4ed7b02'],
      },
    ],
    changes: [
      {
        revision: 12,
        message: 'Marked billing rollout blocked pending credential rotation',
        reason: 'status_change',
        createdAt: '2026-09-25T00:00:00.000Z',
        worktreeIds: ['24ce84ef-8462-474d-91f2-ef30d4ed7b02'],
      },
    ],
  };
}

describe('lazy project views', () => {
  it('uses readable collision-safe worktree folders', () => {
    expect(worktreeFolderName('ptolemy/deploy/pipeline', '8258afc1-xxxx')).toBe(
      'ptolemy-deploy-pipeline--8258afc1',
    );
    expect(worktreeFolderName('', 'f641f325-xxxx')).toBe('detached--f641f325');
  });

  it('extends colliding short worktree identifiers without overwriting a view', () => {
    const data = fixture();
    data.worktrees.push({
      ...data.worktrees[0]!,
      id: '24ce84ef-ffff-474d-91f2-ef30d4ed7b02',
      path: 'C:/repo-two',
    });

    const paths = buildLazyProjectViews(data)
      .filter((view) => view.viewType === 'worktree-now')
      .map((view) => view.relativePath)
      .filter((value) => value.includes('/master--'));
    expect(new Set(paths).size).toBe(2);
    expect(paths.every((value) => value.includes('24ce84ef-'))).toBe(true);
  });

  it('builds one concise deterministic Now view for the project and each live worktree', () => {
    const first = buildLazyProjectViews(fixture());
    const second = buildLazyProjectViews(fixture());

    expect(first).toEqual(second);
    expect(first.map((view) => view.viewId)).toEqual([
      'project-now',
      'worktree:24ce84ef-8462-474d-91f2-ef30d4ed7b02:now',
      'worktree:8258afc1-5187-4c66-8b29-ae850e64d236:now',
    ]);
    expect(first[1]).toMatchObject({
      relativePath: 'Published/Worktrees/master--24ce84ef/Now.md',
      worktreeId: '24ce84ef-8462-474d-91f2-ef30d4ed7b02',
    });
    expect(first[1]?.body).toContain('Complete the billing rollout');
    expect(first[1]?.body).toContain('Credential rotation is incomplete');
    expect(first[1]?.body.split(/\s+/u).length).toBeLessThanOrEqual(400);
    expect(first[0]?.body.split(/\s+/u).length).toBeLessThanOrEqual(600);
  });

  it('states that purpose is unknown instead of inferring it from files', () => {
    const data = fixture();
    data.tasks = [];
    data.workItems = [];
    const view = buildLazyProjectViews(data).find((item) =>
      item.viewId.includes('24ce84ef'),
    );
    expect(view?.body).toContain('purpose is not yet recorded');
  });
});
