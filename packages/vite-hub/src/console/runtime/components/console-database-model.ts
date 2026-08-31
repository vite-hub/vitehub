export interface ConsoleDatabaseColumn {
  foreignKey?: { column: string; table: string };
  name: string;
  nullable?: boolean;
  primary?: boolean;
  type: string;
  unique?: boolean;
}

export interface ConsoleDatabaseTable {
  columns: ConsoleDatabaseColumn[];
  name: string;
  position: { x: number; y: number };
  rows: Record<string, unknown>[];
}

export interface ConsoleDatabaseRelationship {
  from: { column: string; table: string };
  to: { column: string; table: string };
}

export interface ConsoleDatabase {
  relationships: ConsoleDatabaseRelationship[];
  schema: string;
  tables: ConsoleDatabaseTable[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function string(value: unknown): string | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Database inspection payloads are untrusted JSON.
  return typeof value === "string" ? value : undefined;
}

function parseColumn(value: unknown): ConsoleDatabaseColumn | undefined {
  const source = record(value);
  const name = string(source?.name);
  const type = string(source?.type);
  if (!source || !name || !type) return;
  const reference = record(source.foreignKey);
  const table = string(reference?.table);
  const column = string(reference?.column);
  return {
    ...(table && column ? { foreignKey: { column, table } } : {}),
    name,
    ...(source.nullable === true ? { nullable: true } : {}),
    ...(source.primary === true ? { primary: true } : {}),
    type,
    ...(source.unique === true ? { unique: true } : {}),
  };
}

function parseEndpoint(value: unknown): { column: string; table: string } | undefined {
  const source = record(value);
  const table = string(source?.table);
  const column = string(source?.column);
  return table && column ? { column, table } : undefined;
}

export function parseConsoleDatabase(value: unknown): ConsoleDatabase {
  const source = record(value);
  const schema = string(source?.schema);
  if (!source || !schema || !Array.isArray(source.tables) || !Array.isArray(source.relationships)) {
    throw new TypeError("The Console returned an invalid database inspection.");
  }
  const tables = source.tables.flatMap((value): ConsoleDatabaseTable[] => {
    const table = record(value);
    const name = string(table?.name);
    const position = record(table?.position);
    if (
      !table ||
      !name ||
      !Array.isArray(table.columns) ||
      !Array.isArray(table.rows) ||
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Database inspection payloads are untrusted JSON.
      typeof position?.x !== "number" ||
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Database inspection payloads are untrusted JSON.
      typeof position.y !== "number"
    )
      return [];
    const columns = table.columns.map(parseColumn).filter((column) => column !== undefined);
    return columns.length
      ? [
          {
            columns,
            name,
            position: { x: position.x, y: position.y },
            rows: table.rows.flatMap((row): Record<string, unknown>[] => {
              const parsed = record(row);
              return parsed ? [parsed] : [];
            }),
          },
        ]
      : [];
  });
  const relationships = source.relationships.flatMap((value): ConsoleDatabaseRelationship[] => {
    const relationship = record(value);
    const from = parseEndpoint(relationship?.from);
    const to = parseEndpoint(relationship?.to);
    return from && to ? [{ from, to }] : [];
  });
  if (!tables.length) throw new TypeError("The Console returned an empty database inspection.");
  return { relationships, schema, tables };
}
