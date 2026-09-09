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

  it('keeps structural evidence current when an unrelated symbol changes', () => {
    const before = parseSourceUnits(
      'src/service.ts',
      'export function stable() { return 1; }\nexport function changed() { return 1; }',
    );
    const after = parseSourceUnits(
      'src/service.ts',
      'export function stable() { return 1; }\nexport function changed() { return 2; }',
    );
    const hash = (units: typeof before, symbol: string) =>
      units.find((unit) => unit.symbol === symbol)?.contentHash;
    expect(hash(after, 'stable')).toBe(hash(before, 'stable'));
    expect(hash(after, 'changed')).not.toBe(hash(before, 'changed'));
  });
});
