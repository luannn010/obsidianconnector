export interface ParsedEndpoint {
  service: string;
  family: string;
  method: string;
  route: string;
  description: string;
  auth: { principal?: string; permission?: string; ownership?: string };
  idempotency?: string;
  responseSummary?: string;
}

function clean(value: string): string {
  return value.trim().replaceAll('`', '').replaceAll('\\|', '|');
}
function cells(line: string): string[] {
  const marker = '\u0000';
  return line
    .trim()
    .replace(/^\||\|$/gu, '')
    .replaceAll('\\|', marker)
    .split('|')
    .map((cell) => clean(cell.replaceAll(marker, '\\|')));
}
function serviceFor(heading: string): string {
  if (/public|authentication/iu.test(heading)) return 'Public/Auth';
  if (/admin\s+bff/iu.test(heading)) return 'Admin BFF';
  if (/control\s+plane|\/v1/iu.test(heading)) return 'Control Plane';
  if (/internal/iu.test(heading)) return 'Internal Services';
  if (/host\s+agent/iu.test(heading)) return 'Host Agent';
  return heading.replace(/\s+contract.*$/iu, '').trim() || 'Unclassified';
}

export function parseApiContracts(markdown: string): ParsedEndpoint[] {
  const lines = markdown.split(/\r?\n/u);
  const output: ParsedEndpoint[] = [];
  let heading = '';
  let family = '';
  let index = 0;
  while (index < lines.length) {
    const title = lines[index]!.match(/^(##|###)\s+(.+)$/u);
    if (title) {
      if (title[1] === '##') heading = clean(title[2]!);
      else family = clean(title[2]!);
      index++;
      continue;
    }
    if (!lines[index]!.trim().startsWith('|')) {
      index++;
      continue;
    }
    const headers = cells(lines[index]!).map((header) => header.toLowerCase());
    if (
      !headers.some(
        (header) =>
          header === 'method' ||
          header.includes('route') ||
          header.includes('path'),
      )
    ) {
      index++;
      continue;
    }
    index += 2;
    while (index < lines.length && lines[index]!.trim().startsWith('|')) {
      const values = cells(lines[index]!);
      const row = Object.fromEntries(
        headers.map((header, position) => [header, values[position] ?? '']),
      );
      const route =
        row['path'] ?? row['path family'] ?? row['route family'] ?? '';
      const method =
        (row.method || /^(GET|POST|PUT|PATCH|DELETE)\s+/u.exec(route)?.[1]) ??
        'ANY';
      const normalizedRoute = route
        .replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/u, '')
        .trim();
      if (normalizedRoute)
        output.push({
          service: serviceFor(heading),
          family,
          method: method.toUpperCase(),
          route: normalizedRoute,
          description: row.contract ?? row.success ?? '',
          auth: {
            ...(row.principal ? { principal: row.principal } : {}),
            ...(row.permission ? { permission: row.permission } : {}),
            ...(row.ownership ? { ownership: row.ownership } : {}),
          },
          ...(row.idempotency ? { idempotency: row.idempotency } : {}),
          ...(row.success ? { responseSummary: row.success } : {}),
        });
      index++;
    }
  }
  return output;
}
