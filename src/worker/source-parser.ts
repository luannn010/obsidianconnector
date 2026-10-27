import path from 'node:path';
import { EMBEDDING_TEXT_LIMIT } from '../knowledge/embed-text.js';
import { sourceHash } from '../knowledge/hash.js';

export interface SourceUnit {
  kind:
    | 'symbol'
    | 'api_endpoint'
    | 'database_table'
    | 'documentation'
    | 'file_summary';
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

interface DocumentationUnitInput {
  title: string;
  content: string;
  startLine: number;
  endLine: number;
  heading?: string;
  headingLine?: string;
}

interface TextPart {
  content: string;
  start: number;
  end: number;
}

function splitAtTextBoundaries(content: string, limit: number): TextPart[] {
  const parts: TextPart[] = [];
  let start = 0;
  while (start < content.length) {
    while (content[start] === '\n') start++;
    if (start >= content.length) break;
    const remaining = content.slice(start);
    if (remaining.length <= limit) {
      parts.push({ content: remaining.trimEnd(), start, end: content.length });
      break;
    }
    const paragraphBoundary = content.lastIndexOf('\n\n', start + limit);
    const lineBoundary = content.lastIndexOf('\n', start + limit);
    const end =
      paragraphBoundary > start
        ? paragraphBoundary
        : lineBoundary > start
          ? lineBoundary
          : start + limit;
    parts.push({
      content: content.slice(start, end).trimEnd(),
      start,
      end,
    });
    start = end;
  }
  return parts;
}

export function splitDocumentationUnit(
  input: DocumentationUnitInput,
): SourceUnit[] {
  const content = input.content.trim();
  const leadingLineOffset =
    input.content.slice(0, input.content.indexOf(content)).match(/\n/gu)
      ?.length ?? 0;
  const contentStartLine = input.startLine + leadingLineOffset;
  if (content.length <= EMBEDDING_TEXT_LIMIT) {
    return [
      {
        kind: 'documentation',
        title: input.title,
        content,
        startLine: contentStartLine,
        endLine: input.endLine,
        ...(input.heading ? { heading: input.heading } : {}),
        contentHash: sourceHash(content),
      },
    ];
  }

  const firstLineEnd = content.indexOf('\n');
  const firstLine = content.slice(
    0,
    firstLineEnd === -1 ? content.length : firstLineEnd,
  );
  const sourceIncludesHeading = input.headingLine
    ? firstLine.trim() === input.headingLine.trim()
    : /^#{1,6}\s+/u.test(firstLine);
  const headingLine = (
    input.headingLine ?? (sourceIncludesHeading ? firstLine : input.title)
  ).trim();
  const prefix = headingLine.slice(0, EMBEDDING_TEXT_LIMIT - 3);
  const bodyStart = sourceIncludesHeading ? firstLineEnd + 1 : 0;
  const body = content.slice(bodyStart).replace(/^\n+/u, '');
  const skippedLeadingLines =
    content
      .slice(bodyStart, bodyStart + content.slice(bodyStart).indexOf(body))
      .match(/\n/gu)?.length ?? 0;
  const contentLimit = Math.max(1, EMBEDDING_TEXT_LIMIT - prefix.length - 2);
  const parts = splitAtTextBoundaries(body, contentLimit);

  return parts.map((part, index) => {
    const partContent = `${prefix}\n\n${part.content}`.trimEnd();
    const linesBefore = body.slice(0, part.start).match(/\n/gu)?.length ?? 0;
    const partLines = part.content.match(/\n/gu)?.length ?? 0;
    const bodyStartLine =
      contentStartLine + (sourceIncludesHeading ? 1 : 0) + skippedLeadingLines;
    const partBodyStartLine = bodyStartLine + linesBefore;
    const startLine = index === 0 ? contentStartLine : partBodyStartLine;
    return {
      kind: 'documentation',
      title: `${input.title} (part ${index + 1})`,
      content: partContent,
      startLine,
      endLine: Math.min(input.endLine, partBodyStartLine + partLines),
      ...(input.heading ? { heading: input.heading } : {}),
      contentHash: sourceHash(partContent),
    };
  });
}

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '.rb',
  '.php',
]);

function leadingDocComment(extension: string, content: string): string {
  const leading = content.trimStart();
  if (leading.startsWith('/**')) {
    const end = leading.indexOf('*/');
    if (end !== -1) return leading.slice(0, end + 2).slice(0, 400);
  }
  const marker = ['.py', '.rb'].includes(extension) ? '#' : '//';
  const lines = leading.split('\n');
  const commentLines: string[] = [];
  for (const line of lines) {
    if (!line.trimStart().startsWith(marker)) break;
    commentLines.push(line.trim());
  }
  return commentLines.join('\n').slice(0, 400);
}

function declarationSignatures(content: string): string[] {
  const patterns = [
    /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/u,
    /^export\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/u,
    /^(?:async\s+)?def\s+([A-Za-z_][\w]*)/u,
    /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/u,
    /^type\s+([A-Za-z_][\w]*)/u,
    /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_][\w]*)/u,
    /^(?:(?:public|protected|private|internal|abstract|final|static|sealed|partial)\s+)*(?:class|interface|enum|record|function)\s+([A-Za-z_$][\w$]*)/u,
  ];
  const seen = new Set<string>();
  const signatures: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    const match = patterns.map((pattern) => pattern.exec(line)).find(Boolean);
    const name = match?.[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    let signature = line;
    const arrow = signature.indexOf('=>');
    if (arrow !== -1) signature = signature.slice(0, arrow + 2);
    if (/\b(?:function|class|def|fn|func)\b/u.test(signature)) {
      const brace = signature.indexOf('{');
      if (brace !== -1) signature = signature.slice(0, brace + 1);
      const closeParen = signature.lastIndexOf(')');
      const colon = signature.indexOf(':', closeParen + 1);
      if (/\bdef\b/u.test(signature) && colon !== -1)
        signature = signature.slice(0, colon + 1);
      const semicolon = signature.indexOf(';');
      if (/\bdef\b/u.test(signature) && semicolon !== -1)
        signature = signature.slice(0, semicolon);
    }
    signatures.push(signature.trim().slice(0, 160));
  }
  return signatures;
}

function fileSummary(
  relativePath: string,
  extension: string,
  content: string,
): SourceUnit | undefined {
  if (!CODE_EXTENSIONS.has(extension)) return undefined;
  const signatures = declarationSignatures(content);
  if (!signatures.length) return undefined;
  const comment = leadingDocComment(extension, content);
  const summary = [relativePath, comment, ...signatures]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1200);
  return {
    kind: 'file_summary',
    title: relativePath,
    content: summary,
    startLine: 1,
    endLine: content.split('\n').length,
    contentHash: sourceHash(summary),
  };
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
      units.push(
        ...splitDocumentationUnit({
          title: heading,
          heading,
          headingLine: match[0],
          content: section,
          startLine: lineNumber(content, start),
          endLine: lineNumber(content, end),
        }),
      );
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
  const summary = fileSummary(relativePath, extension, content);
  if (summary) units.push(summary);
  const symbolMatches = [
    ...content.matchAll(
      /(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gu,
    ),
  ];
  for (let index = 0; index < symbolMatches.length; index++) {
    const match = symbolMatches[index]!;
    const symbol = match[1] ?? '';
    const start = match.index ?? 0;
    const nextDeclaration = symbolMatches[index + 1]?.index ?? content.length;
    const snippet = content
      .slice(start, Math.min(nextDeclaration, start + 4000))
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
