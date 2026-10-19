import { and, asc, desc, eq, getTableColumns, gt, lt, or } from "drizzle-orm"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { SQL } from "drizzle-orm"
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import type {
  CollectionQueryInput,
  CollectionRequestQuery,
  CollectionSource,
  CursorCollectionSource,
} from "./core/collection.ts"
import { sourceErrorDiagnostics } from "./error-diagnostics.ts"

interface TableShape {
  readonly _: {
    readonly columns: Record<string, unknown>
  }
  readonly $inferSelect: Record<string, unknown>
}

type TableColumn<TTable extends TableShape> = TTable["_"]["columns"][keyof TTable["_"]["columns"]]

type QueryOutput<TSchema extends StandardSchemaV1<unknown, object> | undefined> =
  TSchema extends StandardSchemaV1<unknown, infer TOutput extends object> ? TOutput : CollectionRequestQuery

type QueryInput<TSchema extends StandardSchemaV1<unknown, object> | undefined> =
  TSchema extends StandardSchemaV1<infer TInput extends object, object>
    ? CollectionQueryInput<TInput>
    : CollectionRequestQuery

export interface TableSourceOptions<
  TTable extends TableShape,
  TQuerySchema extends StandardSchemaV1<unknown, object> | undefined = undefined,
> {
  db: {
    select(): unknown
  }
  defaultLimit?: number
  maxLimit?: number
  orderBy: {
    column: TableColumn<TTable>
    direction: "asc" | "desc"
    tieBreaker: TableColumn<TTable>
  }
  querySchema?: TQuerySchema
  table: TTable
  where?: (context: { query: QueryOutput<TQuerySchema>; table: TTable }) => { getSQL(): unknown } | undefined
}

type KeysetCursor = readonly (boolean | null | number | string)[]

// The part of the Drizzle select builder that table() calls.
interface TableSelectDatabase {
  select(): {
    from(table: SQLiteTable): {
      where(where: SQL | undefined): {
        orderBy(...columns: SQL[]): {
          limit(limit: number): PromiseLike<unknown>
        }
      }
    }
  }
}

const requestQuerySchema: StandardSchemaV1<unknown, CollectionRequestQuery> = {
  "~standard": {
    version: 1,
    vendor: "vite-hub",
    validate(value) {
      if (Object(value) !== value || Array.isArray(value)) {
        return { issues: [{ message: "Collection query must be an object." }] }
      }
      // SAFETY: The default query contract permits every own string key on this validated object.
      return { value: value as CollectionRequestQuery }
    },
  },
}

function isCursorScalar(value: unknown): value is boolean | null | number | string {
  return (
    value === null ||
    value === true ||
    value === false ||
    String(value) === value ||
    (Number(value) === value && Number.isFinite(Number(value)))
  )
}

function driverType(column: AnySQLiteColumn): "number" | "string" {
  if (["boolean", "date", "number"].includes(column.dataType)) return "number"
  if (column.dataType === "string") return "string"
  throw sourceErrorDiagnostics.SOURCE_R0029({ message: "[vitehub] Collection orderBy columns must encode as number or string values." })
}

function isColumnDriverValue(column: AnySQLiteColumn, type: "number" | "string", value: unknown): boolean {
  const representationMatches =
    type === "string" ? String(value) === value : Number(value) === value && Number.isFinite(Number(value))
  if (!representationMatches) {
    return false
  }
  try {
    return Object.is(column.mapToDriverValue(column.mapFromDriverValue(value)), value)
  } catch {
    return false
  }
}

function keysetCursorSchema(columns: readonly AnySQLiteColumn[]): StandardSchemaV1<KeysetCursor> {
  const types = columns.map(driverType)
  return {
    "~standard": {
      version: 1,
      vendor: "vite-hub",
      validate(value) {
        if (
          !Array.isArray(value) ||
          value.length !== columns.length ||
          !value.every((entry, index) => isColumnDriverValue(columns[index]!, types[index]!, entry))
        ) {
          return { issues: [{ message: "Collection keyset cursor is malformed." }] }
        }
        const validated: unknown = value
        // SAFETY: Every tuple entry passed its owning Drizzle column driver roundtrip above.
        return { value: validated as KeysetCursor }
      },
    },
  }
}

function columnKey(table: SQLiteTable, column: AnySQLiteColumn): string {
  const entry = Object.entries(getTableColumns(table)).find(([, candidate]) => candidate === column)
  if (!entry) {
    throw sourceErrorDiagnostics.SOURCE_R0030({ message: "[vitehub] Collection orderBy columns must belong to its table." })
  }
  return entry[0]
}

function driverValue(column: AnySQLiteColumn, value: unknown): boolean | null | number | string {
  const encoded = column.mapToDriverValue(value)
  if (!isCursorScalar(encoded)) {
    throw sourceErrorDiagnostics.SOURCE_R0031({ message: "[vitehub] Collection orderBy columns must encode as scalar values." })
  }
  return encoded
}

function cursorWhere(
  columns: readonly AnySQLiteColumn[],
  cursor: KeysetCursor,
  direction: "asc" | "desc",
): SQL | undefined {
  const compare = direction === "asc" ? gt : lt
  return or(
    ...columns.map((column, index) =>
      and(
        ...columns
          .slice(0, index)
          .map((previous, previousIndex) => eq(previous, previous.mapFromDriverValue(cursor[previousIndex]))),
        compare(column, column.mapFromDriverValue(cursor[index])),
      ),
    ),
  )
}

/** Read a Drizzle SQLite table as a Collection source with keyset pagination. */
export function table<TTable extends TableShape, TQuerySchema extends StandardSchemaV1<unknown, object>>(
  options: TableSourceOptions<TTable, TQuerySchema> & {
    querySchema: TQuerySchema
  },
): CollectionSource<
  TTable["$inferSelect"],
  StandardSchemaV1.InferOutput<TQuerySchema>,
  KeysetCursor,
  KeysetCursor,
  QueryInput<TQuerySchema>
>
export function table<TTable extends TableShape>(
  options: TableSourceOptions<TTable> & {
    querySchema?: undefined
  },
): CollectionSource<TTable["$inferSelect"], CollectionRequestQuery, KeysetCursor>
export function table(input: unknown): CursorCollectionSource<TableShape["$inferSelect"], CollectionRequestQuery, KeysetCursor> {
  // SAFETY: Public overloads constrain input to TableSourceOptions before this implementation runs.
  const options = input as TableSourceOptions<TableShape, StandardSchemaV1<unknown, object> | undefined>
  const rawTable: unknown = options.table
  // SAFETY: TableShape is the structural subset supplied by every supported Drizzle SQLite table.
  const databaseTable = rawTable as SQLiteTable
  // SAFETY: TableSourceOptions requires the Drizzle select entry point used below.
  const database = options.db as TableSelectDatabase
  // SAFETY: TableSourceOptions constrains both order columns to this table's column union.
  const columns = [options.orderBy.column, options.orderBy.tieBreaker] as AnySQLiteColumn[]
  const keys = columns.map(column => columnKey(databaseTable, column))

  for (const column of columns) {
    if (!column.notNull) {
      throw sourceErrorDiagnostics.SOURCE_R0032({ message: "[vitehub] Collection orderBy columns must be non-null." })
    }
  }
  const tieBreaker = columns[1]!
  if (!tieBreaker.primary && !tieBreaker.isUnique) {
    throw sourceErrorDiagnostics.SOURCE_R0033({ message: "[vitehub] Collection orderBy tieBreaker must be unique." })
  }

  const direction = options.orderBy.direction
  const order = columns.map(column => (direction === "asc" ? asc(column) : desc(column)))
  // SAFETY: Both the custom and default schemas return object-shaped Collection queries.
  const querySchema = (options.querySchema ?? requestQuerySchema) as StandardSchemaV1<unknown, object>

  return {
    cursor: row => columns.map((column, index) => driverValue(column, row[keys[index]!])),
    cursorSchema: keysetCursorSchema(columns),
    defaultLimit: options.defaultLimit,
    async load({ cursor, limit, query, signal }: { cursor?: KeysetCursor; limit: number; query: CollectionRequestQuery; signal?: AbortSignal }) {
      signal?.throwIfAborted()
      // SAFETY: The where hook contract returns a Drizzle SQL expression when it returns a value.
      const filter = options.where?.({ query, table: options.table }) as SQL | undefined
      const after = cursor ? cursorWhere(columns, cursor, direction) : undefined
      // SAFETY: Drizzle selects the table's declared $inferSelect row shape.
      const rows = (await database
        .select()
        .from(databaseTable)
        .where(and(filter, after))
        .orderBy(...order)
        .limit(limit)) as TableShape["$inferSelect"][]
      signal?.throwIfAborted()
      return rows
    },
    maxLimit: options.maxLimit,
    // SAFETY: Public overloads preserve the concrete schema input/output types.
    querySchema: querySchema as StandardSchemaV1<CollectionRequestQuery, CollectionRequestQuery>,
  }
}
