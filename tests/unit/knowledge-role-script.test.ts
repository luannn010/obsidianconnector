import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('knowledge connector role script', () => {
  it('fails atomically and protects the migration ledger', async () => {
    const sql = await readFile('scripts/create-knowledge-role.sql', 'utf8');
    expect(sql).toContain('\\set ON_ERROR_STOP on');
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain('idle_in_transaction_session_timeout');
    expect(sql).toContain(
      'REVOKE ALL ON project_knowledge.schema_migrations FROM knowledge_connector',
    );
    expect(sql).not.toContain('\\error');
  });
});
