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
    });
    expect(views.map((view) => view.relativePath)).toContain(
      'Published/00 - Project Dashboard.md',
    );
    const api = views.find((view) => view.relativePath.includes('Admin BFF'))!;
    expect(api.body).toContain('POST `/api/servers`');
    expect(api.body).toContain('"name": "world"');
    expect(api.body).toContain('resource.allocate');
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
