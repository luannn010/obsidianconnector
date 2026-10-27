import { describe, expect, it } from 'vitest';
import {
  parseSourceUnits,
  splitDocumentationUnit,
} from '../../src/worker/source-parser.js';

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
    const sql = parseSourceUnits(
      'db/01.sql',
      'CREATE TABLE public.worlds (id uuid);',
    );
    expect(sql).toContainEqual(
      expect.objectContaining({
        kind: 'database_table',
        schemaTable: 'public.worlds',
      }),
    );
    expect(sql.some((unit) => unit.kind === 'file_summary')).toBe(false);
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

  it('produces a file summary from declarations and a leading doc comment', () => {
    const units = parseSourceUnits(
      'src/service.ts',
      `/** Service entry points. */
export interface Options { enabled: boolean }
export async function start(options: Options) {
  return options.enabled;
}`,
    );
    const summary = units.find((unit) => unit.kind === 'file_summary');

    expect(summary).toMatchObject({
      title: 'src/service.ts',
      startLine: 1,
    });
    expect(summary?.content).toContain('src/service.ts');
    expect(summary?.content).toContain('Service entry points.');
    expect(summary?.content).toContain(
      'export interface Options { enabled: boolean }',
    );
    expect(summary?.content).toContain(
      'export async function start(options: Options) {',
    );
    expect(summary?.content.length).toBeLessThanOrEqual(1200);
  });

  it('keeps a file summary unchanged when only a function body changes', () => {
    const before = parseSourceUnits(
      'src/service.ts',
      'export function value() { return 1; }',
    );
    const after = parseSourceUnits(
      'src/service.ts',
      'export function value() { return 2; }',
    );
    const summary = (units: typeof before) =>
      units.find((unit) => unit.kind === 'file_summary');

    expect(summary(after)?.content).toBe(summary(before)?.content);
    expect(summary(after)?.contentHash).toBe(summary(before)?.contentHash);
  });

  it('does not produce a file summary for a code file without declarations', () => {
    const units = parseSourceUnits(
      'src/constants.ts',
      "console.log('no declarations');",
    );

    expect(units.some((unit) => unit.kind === 'file_summary')).toBe(false);
  });

  it('splits long documentation sections with the heading repeated', () => {
    const paragraph = 'Architecture detail '.repeat(45).trim();
    const units = parseSourceUnits(
      'docs/architecture.md',
      `# Architecture\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`,
    );

    expect(units.length).toBeGreaterThan(1);
    for (const [index, unit] of units.entries()) {
      expect(unit.kind).toBe('documentation');
      expect(unit.title).toBe(`Architecture (part ${index + 1})`);
      expect(unit.content.startsWith('# Architecture\n')).toBe(true);
      expect(unit.content.length).toBeLessThanOrEqual(1500);
      expect(unit.startLine).toBeGreaterThanOrEqual(1);
      expect(unit.endLine).toBeGreaterThanOrEqual(unit.startLine);
    }
  });

  it('keeps source line metadata when splitting fallback documentation', () => {
    const paragraph = 'fallback detail '.repeat(70).trim();
    const units = splitDocumentationUnit({
      title: 'notes.txt',
      headingLine: 'notes.txt',
      content: `\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`,
      startLine: 1,
      endLine: 7,
    });

    expect(units).toHaveLength(3);
    expect(units.map((unit) => unit.startLine)).toEqual([3, 5, 7]);
  });
});
