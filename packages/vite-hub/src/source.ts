import { defineCollection as defineCoreCollection } from "@vite-hub/source"
import { and, asc, desc, eq, getTableColumns, gt, lt, or } from "drizzle-orm"

import type {
  Collection,
  CollectionCursorValue,
  CollectionLoader,
  CollectionQueryInput,
  CollectionRequestQuery,
} from "@vite-hub/source"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { SQL } from "drizzle-orm"
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"

export * from "@vite-hub/source"

export interface CollectionSource<
  TSourceItem,
  TQuery extends object,
  TCursorInput extends CollectionCursorValue,
  TCursorOutput extends CollectionCursorValue = TCursorInput,
  TQueryInput extends object = TQuery,
> {
  cursor(item: NoInfer<TSourceItem>): Readonly<TCursorInput>
  cursorSchema: StandardSchemaV1<TCursorInput, TCursorOutput>
  defaultLimit?: number
  load: CollectionLoader<TSourceItem, TQuery, TCursorOutput>
  maxLimit?: number
  querySchema?: StandardSchemaV1<TQueryInput, TQuery>
}

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
  throw new TypeError("[vitehub] Collection orderBy columns must encode as number or string values.")
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
    throw new TypeError("[vitehub] Collection orderBy columns must belong to its table.")
  }
  return entry[0]
}

function driverValue(column: AnySQLiteColumn, value: unknown): boolean | null | number | string {
  const encoded = column.mapToDriverValue(value)
  if (!isCursorScalar(encoded)) {
    throw new TypeError("[vitehub] Collection orderBy columns must encode as scalar values.")
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
export function table(input: unknown): CollectionSource<any, any, KeysetCursor> {
  // SAFETY: Public overloads constrain input to TableSourceOptions before this implementation runs.
  const options = input as TableSourceOptions<TableShape, StandardSchemaV1<unknown, object> | undefined>
  const rawTable: unknown = options.table
  // SAFETY: TableShape is the structural subset supplied by every supported Drizzle SQLite table.
  const databaseTable = rawTable as SQLiteTable
  // SAFETY: TableSourceOptions requires the Drizzle select entry point used below.
  const database = options.db as { select(): any }
  // SAFETY: TableSourceOptions constrains both order columns to this table's column union.
  const columns = [options.orderBy.column, options.orderBy.tieBreaker] as AnySQLiteColumn[]
  const keys = columns.map(column => columnKey(databaseTable, column))

  for (const column of columns) {
    if (!column.notNull) {
      throw new TypeError("[vitehub] Collection orderBy columns must be non-null.")
    }
  }
  const tieBreaker = columns[1]!
  if (!tieBreaker.primary && !tieBreaker.isUnique) {
    throw new TypeError("[vitehub] Collection orderBy tieBreaker must be unique.")
  }

  const direction = options.orderBy.direction
  const order = columns.map(column => (direction === "asc" ? asc(column) : desc(column)))
  // SAFETY: Both the custom and default schemas return object-shaped Collection queries.
  const querySchema = (options.querySchema ?? requestQuerySchema) as StandardSchemaV1<unknown, object>

  return {
    cursor: row => columns.map((column, index) => driverValue(column, row[keys[index]!])),
    cursorSchema: keysetCursorSchema(columns),
    defaultLimit: options.defaultLimit,
    async load({ cursor, limit, query, signal }) {
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
    querySchema,
  }
}

type AnyCollectionSource = CollectionSource<any, any, any, any, any>
type SourceItem<TSource extends AnyCollectionSource> =
  TSource extends CollectionSource<infer TItem, any, any, any, any> ? TItem : never
type SourceQuery<TSource extends AnyCollectionSource> =
  TSource extends CollectionSource<any, infer TQuery, any, any, any> ? TQuery : never
type SourceQueryInput<TSource extends AnyCollectionSource> =
  TSource extends CollectionSource<any, any, any, any, infer TQueryInput> ? TQueryInput : never

interface DefineSourceCollection {
  <TSource extends AnyCollectionSource, TTransform extends (item: NoInfer<SourceItem<TSource>>) => unknown>(options: {
    source: TSource
    transform: TTransform
  }): Collection<Awaited<ReturnType<TTransform>>, SourceQuery<TSource>, SourceQueryInput<TSource>>
  <TSource extends AnyCollectionSource>(options: {
    source: TSource
    transform?: undefined
  }): Collection<SourceItem<TSource>, SourceQuery<TSource>, SourceQueryInput<TSource>>
}

const defineCollectionImplementation = (
  input:
    | Parameters<typeof defineCoreCollection>[0]
    | { source: AnyCollectionSource; transform?: (item: any) => unknown },
  options?: Parameters<typeof defineCoreCollection>[1],
) => {
  const core: unknown = defineCoreCollection
  // SAFETY: This adapter forwards one of the public defineCollection overload argument sets.
  const callCore = core as (...args: unknown[]) => unknown
  if (input instanceof Function) return callCore(input, options)
  const { source, transform } = input
  return callCore(source.load, {
    cursor: source.cursor,
    cursorSchema: source.cursorSchema,
    defaultLimit: source.defaultLimit,
    maxLimit: source.maxLimit,
    querySchema: source.querySchema,
    transform,
  })
}

// SAFETY: The implementation dispatches the core loader and Source object overloads above.
export const defineCollection = defineCollectionImplementation as typeof defineCoreCollection & DefineSourceCollection
