import { describe, expect, it } from 'vitest';
import { parseSequenceFlows } from '../../src/worker/sequence-parser.js';

describe('sequence parser', () => {
  it('extracts headings, status, participants, calls, and responses', () => {
    const flows = parseSequenceFlows(`## Customer provisioning flow
Status: **Implemented** for preview.
\`\`\`mermaid
sequenceDiagram
  actor User
  participant CP as Control Plane
  User->>CP: Create server
  CP-->>User: Accepted
\`\`\``);
    expect(flows[0]).toMatchObject({
      name: 'Customer provisioning flow',
      status: 'implemented',
    });
    expect(flows[0]?.participants).toHaveLength(2);
    expect(flows[0]?.steps).toEqual([
      {
        source: 'User',
        target: 'CP',
        message: 'Create server',
        response: false,
      },
      { source: 'CP', target: 'User', message: 'Accepted', response: true },
    ]);
  });
});
