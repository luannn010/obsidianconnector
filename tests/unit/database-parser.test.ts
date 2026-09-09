import { describe, expect, it } from 'vitest';
import { parseDatabaseMigration } from '../../src/worker/database-parser.js';

describe('database migration parser', () => {
  it('extracts physical schema tables, columns, defaults, and references', () => {
    const result = parseDatabaseMigration(
      '01.sql',
      `CREATE TABLE public.sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES app_users(id),
      expires_at timestamptz NOT NULL
    );`,
    );
    expect(result.tables[0]).toMatchObject({
      schema: 'public',
      name: 'sessions',
    });
    expect(result.tables[0]?.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'id',
          type: 'uuid',
          nullable: false,
          default: 'gen_random_uuid()',
        }),
        expect.objectContaining({
          name: 'user_id',
          type: 'uuid',
          nullable: false,
        }),
      ]),
    );
    expect(result.tables[0]?.relationships[0]).toMatchObject({
      targetSchema: 'public',
      targetTable: 'app_users',
    });
  });
});
