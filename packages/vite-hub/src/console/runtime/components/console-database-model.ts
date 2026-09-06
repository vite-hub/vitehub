import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"
export interface ConsoleDatabaseCell {
  kind: "bigint" | "boolean" | "bytes" | "date" | "json" | "null" | "number" | "text";
  truncated?: true;
  value: string;
}

export interface ConsoleDatabaseColumn {
  foreignKey?: { column: string; table: string };
  key: string;
  name: string;
  nullable: boolean;
  primary: boolean;
  type: string;
  unique: boolean;
}

export interface ConsoleDatabaseTable {
  columns: ConsoleDatabaseColumn[];
  name: string;
  position: { x: number; y: number };
}

export interface ConsoleDatabaseRelationship {
  from: { column: string; table: string };
  to: { column: string; table: string };
}

export interface ConsoleDatabase {
  database: string;
  databases: string[];
  direction: "asc" | "desc";
  limit: number;
  offset: number;
  relationships: ConsoleDatabaseRelationship[];
  rows: Array<Record<string, ConsoleDatabaseCell>>;
  search: string;
  sort?: string;
  table?: string;
  tables: ConsoleDatabaseTable[];
  total: number;
}

export function consoleDatabaseRequestQuery(input: {
  database?: string;
  direction: "asc" | "desc";
  offset: number;
  search: string;
  sort: string;
  table?: string;
  view: "data" | "schema";
}): Record<string, unknown> {
  if (input.view === "schema") return { database: input.database };
  return {
    database: input.database,
    direction: input.direction,
    limit: 50,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort || undefined,
    table: input.table,
  };
}

const cellKinds = new Set<ConsoleDatabaseCell["kind"]>([
  "bigint",
  "boolean",
  "bytes",
  "date",
  "json",
  "null",
  "number",
  "text",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function string(value: unknown): string | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Database inspection payloads are untrusted JSON.
  return typeof value === "string" ? value : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Database inspection payloads are untrusted JSON.
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseColumn(value: unknown): ConsoleDatabaseColumn | undefined {
  const source = record(value);
  const key = string(source?.key);
  const name = string(source?.name);
  const type = string(source?.type);
  if (!source || !key || !name || !type) return;
  const reference = record(source.foreignKey);
  const table = string(reference?.table);
  const column = string(reference?.column);
  return {
    ...(table && column ? { foreignKey: { column, table } } : {}),
    key,
    name,
    nullable: source.nullable === true,
    primary: source.primary === true,
    type,
    unique: source.unique === true,
  };
}

function parseEndpoint(value: unknown): { column: string; table: string } | undefined {
  const source = record(value);
  const table = string(source?.table);
  const column = string(source?.column);
  return table && column ? { column, table } : undefined;
}

function parseCell(value: unknown): ConsoleDatabaseCell | undefined {
  const source = record(value);
  // SAFETY: The cell kind is checked against the complete ConsoleDatabaseCell kind set before it is returned.
  const kind = string(source?.kind) as ConsoleDatabaseCell["kind"] | undefined;
  const rendered = string(source?.value);
  if (!source || !kind || !cellKinds.has(kind) || rendered === undefined) return;
  return {
    kind,
    ...(source.truncated === true ? { truncated: true } : {}),
    value: rendered,
  };
}

function positionTables(
  tables: Array<Omit<ConsoleDatabaseTable, "position">>,
): ConsoleDatabaseTable[] {
  const columnHeights = [32, 32, 32];
  return tables.map((table) => {
    const column = columnHeights.indexOf(Math.min(...columnHeights));
    // SAFETY: columnHeights always contains three entries and indexOf finds one of those entries.
    const position = { x: 32 + column * 320, y: columnHeights[column]! };
    columnHeights[column] = position.y + 58 + table.columns.length * 25;
    return { ...table, position };
  });
}

export function parseConsoleDatabase(value: unknown): ConsoleDatabase {
  const source = record(value);
  const database = string(source?.database);
  const direction =
    source?.direction === "desc" ? "desc" : source?.direction === "asc" ? "asc" : undefined;
  const limit = finiteInteger(source?.limit);
  const offset = finiteInteger(source?.offset);
  const total = finiteInteger(source?.total);
  const search = string(source?.search);
  if (
    !source ||
    !database ||
    !direction ||
    limit === undefined ||
    limit < 1 ||
    offset === undefined ||
    total === undefined ||
    search === undefined ||
    !Array.isArray(source.databases) ||
    !Array.isArray(source.tables) ||
    !Array.isArray(source.relationships) ||
    !Array.isArray(source.rows)
  ) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0042({ message: "The Console returned an invalid database inspection." });
  }
  const databases = source.databases.filter(
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Database inspection payloads are untrusted JSON.
    (name): name is string => typeof name === "string" && Boolean(name),
  );
  const tableEntries = source.tables.flatMap(
    (value): Array<Omit<ConsoleDatabaseTable, "position">> => {
      const table = record(value);
      const name = string(table?.name);
      if (!table || !name || !Array.isArray(table.columns)) return [];
      const columns = table.columns.map(parseColumn).filter((column) => column !== undefined);
      return columns.length ? [{ columns, name }] : [];
    },
  );
  const relationships = source.relationships.flatMap((value): ConsoleDatabaseRelationship[] => {
    const relationship = record(value);
    const from = parseEndpoint(relationship?.from);
    const to = parseEndpoint(relationship?.to);
    return from && to ? [{ from, to }] : [];
  });
  const rows = source.rows.flatMap((value): Array<Record<string, ConsoleDatabaseCell>> => {
    const row = record(value);
    if (!row) return [];
    const cells = Object.entries(row).flatMap(([key, value]) => {
      const parsed = parseCell(value);
      return parsed ? [[key, parsed] as const] : [];
    });
    return cells.length === Object.keys(row).length ? [Object.fromEntries(cells)] : [];
  });
  if (!databases.includes(database)) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0043({ message: "The Console returned an invalid database inspection." });
  }
  const table = string(source.table);
  if (table && !tableEntries.some((entry) => entry.name === table)) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0044({ message: "The Console returned an invalid database inspection." });
  }
  const sort = string(source.sort);
  return {
    database,
    databases,
    direction,
    limit,
    offset,
    relationships,
    rows,
    search,
    ...(sort ? { sort } : {}),
    ...(table ? { table } : {}),
    tables: positionTables(tableEntries),
    total,
  };
}
