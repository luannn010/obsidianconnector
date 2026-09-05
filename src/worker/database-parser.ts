export interface ParsedColumn {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  primaryKey: boolean;
}

export interface ParsedRelationship {
  sourceColumn: string;
  targetSchema: string;
  targetTable: string;
  targetColumn: string;
}

export interface ParsedTable {
  schema: string;
  name: string;
  columns: ParsedColumn[];
  relationships: ParsedRelationship[];
}

export interface ParsedMigration {
  path: string;
  tables: ParsedTable[];
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = '';
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function tableBodies(
  sql: string,
): Array<{ schema: string; name: string; body: string }> {
  const output: Array<{ schema: string; name: string; body: string }> = [];
  const expression =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?<schema>[\w"]+)\.)?(?<name>[\w"]+)\s*\(/giu;
  for (const match of sql.matchAll(expression)) {
    const bodyStart = match.index! + match[0].length;
    let depth = 1;
    let quote = '';
    let index = bodyStart;
    for (; index < sql.length && depth > 0; index++) {
      const character = sql[index]!;
      if (quote) {
        if (character === quote && sql[index - 1] !== '\\') quote = '';
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }
      if (character === '(') depth++;
      else if (character === ')') depth--;
    }
    if (depth === 0)
      output.push({
        schema: (match.groups?.schema ?? 'public').replaceAll('"', ''),
        name: match.groups!.name!.replaceAll('"', ''),
        body: sql.slice(bodyStart, index - 1),
      });
  }
  return output;
}

export function parseDatabaseMigration(
  migrationPath: string,
  sql: string,
): ParsedMigration {
  const tables = tableBodies(sql).map(({ schema, name, body }) => {
    const columns: ParsedColumn[] = [];
    const relationships: ParsedRelationship[] = [];
    for (const definition of splitTopLevel(body)) {
      if (
        /^(?:CONSTRAINT\s+\S+\s+)?(?:PRIMARY|FOREIGN|UNIQUE|CHECK)\b/iu.test(
          definition,
        )
      ) {
        const foreign = definition.match(
          /FOREIGN\s+KEY\s*\(\s*"?(\w+)"?\s*\)\s+REFERENCES\s+(?:(\w+)\.)?(\w+)\s*\(\s*"?(\w+)"?\s*\)/iu,
        );
        if (foreign)
          relationships.push({
            sourceColumn: foreign[1]!,
            targetSchema: foreign[2] ?? schema,
            targetTable: foreign[3]!,
            targetColumn: foreign[4]!,
          });
        continue;
      }
      const column = definition.match(
        /^"?(\w+)"?\s+([\w]+(?:\s*\([^)]*\))?(?:\s+with(?:out)?\s+time\s+zone)?)([\s\S]*)$/iu,
      );
      if (!column) continue;
      const constraints = column[3] ?? '';
      const defaultMatch = constraints.match(
        /\bDEFAULT\s+(.+?)(?=\s+(?:NOT\s+NULL|NULL|PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK|CONSTRAINT)\b|$)/iu,
      );
      const primaryKey = /\bPRIMARY\s+KEY\b/iu.test(constraints);
      columns.push({
        name: column[1]!,
        type: column[2]!.replace(/\s+/gu, ' ').trim().toLowerCase(),
        nullable: !primaryKey && !/\bNOT\s+NULL\b/iu.test(constraints),
        ...(defaultMatch ? { default: defaultMatch[1]!.trim() } : {}),
        primaryKey,
      });
      const reference = constraints.match(
        /\bREFERENCES\s+(?:(\w+)\.)?(\w+)\s*\(\s*"?(\w+)"?\s*\)/iu,
      );
      if (reference)
        relationships.push({
          sourceColumn: column[1]!,
          targetSchema: reference[1] ?? schema,
          targetTable: reference[2]!,
          targetColumn: reference[3]!,
        });
    }
    return { schema, name, columns, relationships };
  });
  return { path: migrationPath, tables };
}
