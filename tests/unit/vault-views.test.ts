import { describe, expect, it } from 'vitest';
import { buildProjectViews } from '../../src/worker/vault-views.js';

describe('v2 vault views', () => {
  it('renders per-domain sync state and unmapped worktree changes', () => {
    const views = buildProjectViews({
      projectId: 'p1',
      projectKey: 'MC-Platform',
      dbRevision: 9,
      gitRevision: 'head',
      architecture: [],
      workItems: [],
      worktrees: [],
      endpoints: [],
      sequences: [],
      schemas: [],
      mappings: [],
      decisions: [],
      projections: [],
      legacyCount: 0,
      documentationFreshness: {
        current: 0,
        possiblyStale: 0,
        stale: 1,
        missing: 0,
        unverified: 0,
      },
      agentTasks: [],
      domainSync: {
        worktreeId: 'worktree-1',
        worktreePath: 'C:/repo',
        branch: 'feature/rcon',
        currentCommit: 'head',
        currentDirtyHash: 'dirty',
        indexedCommit: 'head',
        indexedDirtyHash: 'dirty',
        snapshotId: 'snapshot-1',
        unmappedChanges: ['scratch/unknown.txt'],
        domains: [
          {
            name: 'Server control',
            notePath:
              'Published/01 - Architecture/Domains/Server control.md',
            state: 'stale',
            lastSyncedCommit: 'base',
            currentCommit: 'head',
            currentDirtyHash: 'dirty',
            databaseRevision: 9,
            projectionRevision: 8,
            reasons: ['Mapped source paths changed'],
            changedPaths: ['services/host-agent/src/rcon.ts'],
            evidenceRefs: ['knowledge:item-1:v2'],
          },
        ],
      },
    });

    const index = views.find((view) => view.viewId === 'interaction-index')!;
    expect(index.body).toContain('Server control');
    expect(index.body).toContain('stale');
    expect(index.body).toContain('`base`');
    expect(index.body).toContain('`head`');
    const domain = views.find(
      (view) => view.viewId === 'domain:Server control',
    )!;
    expect(domain.body).toContain('services/host-agent/src/rcon.ts');
    expect(domain.metadata).toMatchObject({
      current_commit: 'head',
      domain: 'Server control',
      sync_status: 'stale',
      worktree: 'C:/repo',
    });
    const sync = views.find((view) => view.viewId === 'sync-status')!;
    expect(sync.body).toContain('scratch/unknown.txt');
  });

  it('renders the compact dashboard and descriptive service API contract', () => {
    const views = buildProjectViews({
      projectId: 'p1',
      projectKey: 'MC-Platform',
      dbRevision: 4,
      gitRevision: 'abc',
      architecture: [
        { title: 'Runtime', body: 'PlayNode Core owns browser traffic.' },
      ],
      workItems: [
        {
          title: 'Knowledge index',
          status: 'active',
          verificationStatus: 'unverified',
          worktrees: ['feature@index'],
        },
      ],
      worktrees: [
        {
          branch: 'feature',
          head: 'abc',
          dirty: true,
          registered: true,
          freshness: 'current',
        },
      ],
      endpoints: [
        {
          service: 'Admin BFF',
          method: 'POST',
          route: '/api/servers',
          description: 'Creates an owned server.',
          auth: { permission: 'resource.allocate' },
          request: { type: 'object' },
          responses: { '202': { description: 'Accepted' } },
          examples: [
            { type: 'request', title: 'Create', payload: { name: 'world' } },
            {
              type: 'response',
              statusCode: 202,
              title: 'Accepted',
              payload: { operation: { status: 'pending' } },
            },
          ],
          status: 'implemented',
          gitRevision: 'abc',
        },
      ],
      sequences: [],
      schemas: [],
      mappings: [],
      decisions: [],
      projections: [],
      legacyCount: 101,
      documentationFreshness: {
        current: 3,
        possiblyStale: 0,
        stale: 1,
        missing: 0,
        unverified: 2,
      },
      agentTasks: [
        {
          agent: 'codex',
          taskId: 'task-123456789',
          taskName: 'Update observer grants',
          status: 'active',
          worktree: 'C:/repo/.worktrees/observer',
          branch: 'ptolemy/observer',
          startRevision: 'abc',
          currentRevision: 'def',
          documentationGate: 'stale',
          startedAt: '2026-09-05T00:00:00.000Z',
          lastActivityAt: '2026-09-05T00:05:00.000Z',
          files: [
            {
              path: 'services/observer/server/database.js',
              actions: ['read', 'edit'],
              accessCount: 2,
              firstAccessAt: '2026-09-05T00:01:00.000Z',
              lastAccessAt: '2026-09-05T00:04:00.000Z',
              changed: true,
            },
          ],
          documentation: [
            {
              ref: 'knowledge:item-1:v2',
              title: 'Observer database boundary',
              state: 'stale',
            },
          ],
          verificationEvidence: [
            {
              locatorType: 'test',
              path: 'services/observer/tests/database.test.js',
              sourceHash: 'test-hash',
            },
          ],
        },
      ],
    });
    expect(views.map((view) => view.relativePath)).toContain(
      'Published/00 - Project Dashboard.md',
    );
    const api = views.find((view) => view.relativePath.includes('Admin BFF'))!;
    expect(api.body).toContain('POST `/api/servers`');
    expect(api.body).toContain('"name": "world"');
    expect(api.body).toContain('resource.allocate');
    expect(
      views.some((view) => view.relativePath.includes('/Delivery/Tasks/')),
    ).toBe(false);
    expect(views.some((view) => view.viewId === 'task-activity')).toBe(false);
    expect(views[0]?.body).not.toContain('Active agent tasks');
    expect(views[0]?.body).not.toContain('Task Activity');
    const history = views.find((view) => view.viewId === 'change-history')!;
    expect(history.body).toContain('Projection cleanup');
  });

  it('keeps long architecture documents out of the dashboard', () => {
    const base = {
      projectId: 'p',
      projectKey: 'P',
      dbRevision: 1,
      gitRevision: 'g',
      workItems: [],
      worktrees: [],
      endpoints: [],
      sequences: [],
      schemas: [],
      mappings: [],
      decisions: [],
      projections: [],
      legacyCount: 0,
      documentationFreshness: {
        current: 0,
        possiblyStale: 0,
        stale: 0,
        missing: 0,
        unverified: 0,
      },
      agentTasks: [],
    };
    const dashboard = buildProjectViews({
      ...base,
      architecture: [
        {
          title: 'Architecture',
          body: `Deployment summary.\n\n${'detail '.repeat(3000)}`,
        },
      ],
    })[0]!;
    expect(dashboard.body.length).toBeLessThan(2000);
    expect(dashboard.body).toContain('Deployment summary.');
  });

  it('keeps agent task status out of published views', () => {
    const task = {
      agent: 'codex' as const,
      taskId: 'server-worktree-one',
      taskName: 'Untitled task',
      status: 'active',
      worktree: 'C:/repo',
      branch: 'feature/one',
      startRevision: 'abc',
      currentRevision: 'def',
      documentationGate: 'unverified',
      startedAt: '2026-09-05T00:00:00.000Z',
      lastActivityAt: '2026-09-05T00:05:00.000Z',
      files: [],
      documentation: [],
      verificationEvidence: [],
    };
    const views = buildProjectViews({
      projectId: 'p',
      projectKey: 'P',
      dbRevision: 1,
      gitRevision: 'g',
      architecture: [],
      workItems: [],
      worktrees: [],
      endpoints: [],
      sequences: [],
      schemas: [],
      mappings: [],
      decisions: [],
      projections: [],
      legacyCount: 0,
      documentationFreshness: {
        current: 0,
        possiblyStale: 0,
        stale: 0,
        missing: 0,
        unverified: 0,
      },
      agentTasks: [
        task,
        { ...task, taskId: 'server-worktree-two', branch: 'feature/two' },
      ],
    });

    expect(views.some((view) => view.viewType === 'agent-task')).toBe(false);
    expect(views.some((view) => view.viewType === 'task-activity')).toBe(false);
  });

  it('reports the current database revision for projections that will be refreshed', () => {
    const sync = buildProjectViews({
      projectId: 'p',
      projectKey: 'P',
      dbRevision: 10,
      gitRevision: 'g',
      architecture: [],
      workItems: [],
      worktrees: [],
      endpoints: [],
      sequences: [],
      schemas: [],
      mappings: [],
      decisions: [],
      projections: [
        {
          path: 'Published/01 - Architecture/00 - Architecture Overview.md',
          state: 'current',
          revision: 9,
        },
        {
          path: 'Published/01 - Architecture/Domains/Server control.md',
          state: 'drifted',
          revision: 9,
        },
      ],
      legacyCount: 0,
      documentationFreshness: {
        current: 0,
        possiblyStale: 0,
        stale: 0,
        missing: 0,
        unverified: 0,
      },
      agentTasks: [],
    }).find((view) => view.viewId === 'sync-status')!;

    expect(sync.body).toContain(
      'Published/01 - Architecture/00 - Architecture Overview.md | current | 10',
    );
    expect(sync.body).toContain(
      'Published/01 - Architecture/Domains/Server control.md | drifted | 9',
    );
  });
});
