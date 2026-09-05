import { describe, expect, it } from 'vitest';
import { parseSourceUnits } from '../../src/worker/source-parser.js';

describe('source parser', () => {
  it('extracts symbols, HTTP routes, SQL tables, and markdown headings as atomic units', () => {
    const js = parseSourceUnits(
      'src/server.js',
      `export function start() {}\nif (req.method === 'POST' && url.pathname === '/api/worlds') {}`,
    );
    expect(js).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'symbol', symbol: 'start' }),
        expect.objectContaining({
          kind: 'api_endpoint',
          endpoint: 'POST /api/worlds',
        }),
      ]),
    );
    expect(
      parseSourceUnits('db/01.sql', 'CREATE TABLE public.worlds (id uuid);'),
    ).toContainEqual(
      expect.objectContaining({
        kind: 'database_table',
        schemaTable: 'public.worlds',
      }),
    );
    expect(
      parseSourceUnits(
        'docs/a.md',
        '# Architecture\nText\n## Failure modes\nMore',
      ),
    ).toHaveLength(2);
  });

  it('deduplicates repeated symbol declarations within a file snapshot', () => {
    const units = parseSourceUnits(
      'src/repeated.ts',
      'function text() {}\nfunction text() {}',
    );
    expect(units.filter((unit) => unit.symbol === 'text')).toHaveLength(1);
  });
});
