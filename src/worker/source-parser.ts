import path from 'node:path';
import { sourceHash } from '../knowledge/hash.js';

export interface SourceUnit {
  kind: 'symbol' | 'api_endpoint' | 'database_table' | 'documentation';
  title: string;
  content: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  endpoint?: string;
  schemaTable?: string;
  heading?: string;
  contentHash: string;
}

function lineNumber(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

export function parseSourceUnits(
  relativePath: string,
  content: string,
): SourceUnit[] {
  const extension = path.extname(relativePath).toLowerCase();
  const units: SourceUnit[] = [];
  if (extension === '.md') {
    const headings = [...content.matchAll(/^(#{1,6})\s+(.+)$/gmu)];
    headings.forEach((match, index) => {
      const start = match.index ?? 0;
      const end = headings[index + 1]?.index ?? content.length;
      const section = content.slice(start, end).trim();
      const heading = match[2]?.trim() ?? path.basename(relativePath);
      units.push({
        kind: 'documentation',
        title: heading,
        heading,
        content: section,
        startLine: lineNumber(content, start),
        endLine: lineNumber(content, end),
        contentHash: sourceHash(section),
      });
    });
    return units;
  }
  if (extension === '.sql') {
    for (const match of content.matchAll(
      /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/giu,
    )) {
      const raw = match[1] ?? '';
      const schemaTable = raw.includes('.') ? raw : `public.${raw}`;
      const start = match.index ?? 0;
      const snippet = content
        .slice(start, Math.min(content.length, start + 1200))
        .trim();
      units.push({
        kind: 'database_table',
        title: schemaTable,
        schemaTable,
        content: snippet,
        startLine: lineNumber(content, start),
        endLine: lineNumber(content, start + snippet.length),
        contentHash: sourceHash(snippet),
      });
    }
  }
  for (const match of content.matchAll(
    /(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gu,
  )) {
    const symbol = match[1] ?? '';
    const start = match.index ?? 0;
    const snippet = content
      .slice(start, Math.min(content.length, start + 1000))
      .trim();
    units.push({
      kind: 'symbol',
      title: symbol,
      symbol,
      content: snippet,
      startLine: lineNumber(content, start),
      endLine: lineNumber(content, start + snippet.length),
      contentHash: sourceHash(snippet),
    });
  }
  const routePatterns = [
    /(?:req\.method|method)\s*={2,3}\s*['"](GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)['"][\s\S]{0,180}?(?:url\.pathname|pathname)\s*={2,3}\s*['"]([^'"]+)['"]/giu,
    /\.(get|post|put|patch|delete|options|head)\(\s*['"]([^'"]+)['"]/giu,
  ];
  for (const pattern of routePatterns) {
    for (const match of content.matchAll(pattern)) {
      const endpoint = `${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`;
      const start = match.index ?? 0;
      const snippet = content
        .slice(start, Math.min(content.length, start + 1200))
        .trim();
      units.push({
        kind: 'api_endpoint',
        title: endpoint,
        endpoint,
        content: snippet,
        startLine: lineNumber(content, start),
        endLine: lineNumber(content, start + snippet.length),
        contentHash: sourceHash(snippet),
      });
    }
  }
  const seenSymbols = new Set<string>();
  return units.filter((unit) => {
    if (!unit.symbol) return true;
    if (seenSymbols.has(unit.symbol)) return false;
    seenSymbols.add(unit.symbol);
    return true;
  });
}
