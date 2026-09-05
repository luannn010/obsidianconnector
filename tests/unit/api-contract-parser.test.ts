import { describe, expect, it } from 'vitest';
import { parseApiContracts } from '../../src/worker/api-contract-parser.js';

describe('API contract parser', () => {
  it('maps route families to services and preserves descriptive fields', () => {
    const result = parseApiContracts(`## Admin BFF \`/api\` contract
### Lifecycle
| Method | Path family | Permission | Ownership | Idempotency | Success |
| --- | --- | --- | --- | --- | --- |
| POST | \`/api/servers\` | \`resource.allocate\` | Actor | Required | \`202\` allocation. |

## Control Plane \`/v1\` contract
| Route family | Permission | Contract |
| --- | --- | --- |
| \`/v1/hosts[/...]\` | \`config.manage\` | Host administration. |
`);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service: 'Admin BFF',
          method: 'POST',
          route: '/api/servers',
          auth: expect.objectContaining({
            permission: 'resource.allocate',
            ownership: 'Actor',
          }),
          idempotency: 'Required',
        }),
        expect.objectContaining({
          service: 'Control Plane',
          method: 'ANY',
          route: '/v1/hosts[/...]',
          description: 'Host administration.',
        }),
      ]),
    );
  });
});
