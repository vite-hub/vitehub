import { defineCollection as defineCoreCollection } from "@vite-hub/source"
import { and, asc, desc, eq, getTableColumns, gt, lt, or } from "drizzle-orm"

import type {
  Collection,
  CollectionCursorValue,
  CollectionLoader,
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
> {
  cursor(item: NoInfer<TSourceItem>): Readonly<TCursorInput>
  cursorSchema: StandardSchemaV1<TCursorInput, TCursorOutput>
  defaultLimit?: number
  load: CollectionLoader<TSourceItem, TQuery, TCursorOutput>
  maxLimit?: number
  querySchema?: StandardSchemaV1<unknown, TQuery>
}

interface TableShape {
  readonly _: {
    readonly columns: Record<string, unknown>
  }
  readonly $inferSelect: Record<string, unknown>
}

type TableColumn<TTable extends TableShape> =
  TTable["_"]["columns"][keyof TTable["_"]["columns"]]

type QueryOutput<TSchema extends StandardSchemaV1<unknown, object> | undefined> =
  TSchema extends StandardSchemaV1<unknown, infer TOutput extends object>
    ? TOutput
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
  where?: (context: {
    query: QueryOutput<TQuerySchema>
    table: TTable
  }) => { getSQL(): unknown } | undefined
}

type KeysetCursor = readonly (boolean | null | number | string)[]

const requestQuerySchema: StandardSchemaV1<unknown, CollectionRequestQuery> = {
  "~standard": {
    version: 1,
    vendor: "vite-hub",
    validate(value) {
      return value && typeof value === "object" && !Array.isArray(value)
        ? { value: value as CollectionRequestQuery }
        : { issues: [{ message: "Collection query must be an object." }] }
    },
  },
}

function isCursorScalar(value: unknown): value is boolean | null | number | string {
  return value === null
    || typeof value === "boolean"
    || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value))
}

function driverType(column: AnySQLiteColumn): "number" | "string" {
  if (["boolean", "date", "number"].includes(column.dataType)) return "number"
  if (column.dataType === "string") return "string"
  throw new TypeError("[vitehub] Collection orderBy columns must encode as number or string values.")
}

function keysetCursorSchema(columns: readonly AnySQLiteColumn[]): StandardSchemaV1<KeysetCursor> {
  const types = columns.map(driverType)
  return {
    "~standard": {
      version: 1,
      vendor: "vite-hub",
      validate(value) {
        return Array.isArray(value)
          && value.length === columns.length
          && value.every((entry, index) => typeof entry === types[index]
            && (typeof entry !== "number" || Number.isFinite(entry)))
          ? { value: value as unknown as KeysetCursor }
          : { issues: [{ message: "Collection keyset cursor is malformed." }] }
      },
    },
  }
}

function columnKey(table: SQLiteTable, column: AnySQLiteColumn): string {
  const entry = Object.entries(getTableColumns(table))
    .find(([, candidate]) => candidate === column)
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
  return or(...columns.map((column, index) => and(
    ...columns.slice(0, index).map((previous, previousIndex) =>
      eq(previous, previous.mapFromDriverValue(cursor[previousIndex])),
    ),
    compare(column, column.mapFromDriverValue(cursor[index])),
  )))
}

export function table<
  TTable extends TableShape,
  TQuerySchema extends StandardSchemaV1<unknown, object>,
>(options: TableSourceOptions<TTable, TQuerySchema> & {
  querySchema: TQuerySchema
}): CollectionSource<
  TTable["$inferSelect"],
  StandardSchemaV1.InferOutput<TQuerySchema>,
  KeysetCursor
>
export function table<
  TTable extends TableShape,
>(options: TableSourceOptions<TTable> & {
  querySchema?: undefined
}): CollectionSource<TTable["$inferSelect"], CollectionRequestQuery, KeysetCursor>
export function table(input: unknown): CollectionSource<
  any,
  any,
  KeysetCursor
> {
  const options = input as TableSourceOptions<
    TableShape,
    StandardSchemaV1<unknown, object> | undefined
  >
  const databaseTable = options.table as unknown as SQLiteTable
  const database = options.db as { select(): any }
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
  const order = columns.map(column => direction === "asc" ? asc(column) : desc(column))
  const querySchema = (options.querySchema ?? requestQuerySchema) as StandardSchemaV1<unknown, object>

  return {
    cursor: row => columns.map((column, index) => driverValue(column, row[keys[index]!])),
    cursorSchema: keysetCursorSchema(columns),
    defaultLimit: options.defaultLimit,
    async load({ cursor, limit, query, signal }) {
      signal?.throwIfAborted()
      const filter = options.where?.({ query, table: options.table }) as SQL | undefined
      const after = cursor ? cursorWhere(columns, cursor, direction) : undefined
      const rows = await database
        .select()
        .from(databaseTable)
        .where(and(filter, after))
        .orderBy(...order)
        .limit(limit) as TableShape["$inferSelect"][]
      signal?.throwIfAborted()
      return rows
    },
    maxLimit: options.maxLimit,
    querySchema,
  }
}

type AnyCollectionSource = CollectionSource<any, any, any, any>
type SourceItem<TSource extends AnyCollectionSource> =
  TSource extends CollectionSource<infer TItem, any, any, any> ? TItem : never
type SourceQuery<TSource extends AnyCollectionSource> =
  TSource extends CollectionSource<any, infer TQuery, any, any> ? TQuery : never

interface DefineSourceCollection {
  <TSource extends AnyCollectionSource, TTransform extends (
    item: NoInfer<SourceItem<TSource>>,
  ) => unknown>(options: {
    source: TSource
    transform: TTransform
  }): Collection<Awaited<ReturnType<TTransform>>, SourceQuery<TSource>>
  <TSource extends AnyCollectionSource>(options: {
    source: TSource
    transform?: undefined
  }): Collection<SourceItem<TSource>, SourceQuery<TSource>>
}

export const defineCollection = ((
  input: Parameters<typeof defineCoreCollection>[0] | { source: AnyCollectionSource, transform?: (item: any) => unknown },
  options?: Parameters<typeof defineCoreCollection>[1],
) => {
  const callCore = defineCoreCollection as unknown as (...args: unknown[]) => unknown
  if (typeof input === "function") return callCore(input, options)
  const { source, transform } = input
  return callCore(source.load, {
    cursor: source.cursor,
    cursorSchema: source.cursorSchema,
    defaultLimit: source.defaultLimit,
    maxLimit: source.maxLimit,
    querySchema: source.querySchema,
    transform,
  })
}) as typeof defineCoreCollection & DefineSourceCollection
