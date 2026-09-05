import { describe, expect, it } from 'vitest';
import { buildProjectViews } from '../../src/worker/vault-views.js';

describe('v2 vault views', () => {
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
    const activity = views.find(
      (view) =>
        view.relativePath === 'Published/02 - Delivery/02 - Task Activity.md',
    )!;
    expect(activity.body).toContain('Update observer grants');
    expect(activity.body).toContain('task-123456789');
    expect(activity.body).toContain('ptolemy/observer');
    const task = views.find((view) => view.relativePath.includes('/Tasks/'))!;
    expect(task.body).toContain('services/observer/server/database.js');
    expect(task.body).toContain('Codex');
    expect(task.body).toContain('knowledge:item-1:v2');
    expect(task.body).toContain('services/observer/tests/database.test.js');
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
});
