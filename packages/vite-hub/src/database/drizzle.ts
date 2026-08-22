import {
  databases as runtimeDatabases,
  schema,
  useDatabase as useRuntimeDatabase,
} from "@vite-hub/database/drizzle"
import { defineCollection } from "@vite-hub/source"
import { and, asc, desc, eq, getTableColumns, gt, lt, or } from "drizzle-orm"

import type { RuntimeDatabaseEntry } from "@vite-hub/database/drizzle"
import type { Collection, CollectionRequestQuery } from "@vite-hub/source"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { SQL } from "drizzle-orm"
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"

export * from "@vite-hub/database/drizzle"

export interface DatabaseRegistry {}

type RegisteredDatabaseSchema<Name extends keyof DatabaseRegistry> = DatabaseRegistry[Name] extends {
  schema: infer TSchema extends Record<string, unknown>
} ? TSchema : never

type RuntimeDatabaseRegistry = {
  [Name in keyof DatabaseRegistry]: RuntimeDatabaseEntry<RegisteredDatabaseSchema<Name>>
}

type RuntimeDatabaseLookup = RuntimeDatabaseRegistry & {
  default: RuntimeDatabaseEntry<typeof schema>
} & Record<string, RuntimeDatabaseEntry<Record<string, unknown>>>

export const databases = runtimeDatabases as RuntimeDatabaseLookup

export function useDatabase<Name extends keyof RuntimeDatabaseRegistry>(name: Name): RuntimeDatabaseRegistry[Name] {
  return useRuntimeDatabase(name as never) as RuntimeDatabaseRegistry[Name]
}

interface DrizzleTable {
  readonly _: {
    readonly columns: Record<string, unknown>
  }
  readonly $inferSelect: Record<string, unknown>
}

type TableColumn<TTable extends DrizzleTable> =
  TTable["_"]["columns"][keyof TTable["_"]["columns"]]

type QueryOutput<TSchema extends StandardSchemaV1<unknown, object> | undefined> =
  TSchema extends StandardSchemaV1<unknown, infer TOutput extends object>
    ? TOutput
    : CollectionRequestQuery

export interface DrizzleCollectionOptions<
  TSchema extends Record<string, unknown>,
  TTable extends DrizzleTable,
  TQuerySchema extends StandardSchemaV1<unknown, object> | undefined = undefined,
> {
  db: RuntimeDatabaseEntry<TSchema>["db"]
  defaultLimit?: number
  keyset: {
    by: TableColumn<TTable>
    order: "asc" | "desc"
    tieBreaker: TableColumn<TTable>
  }
  maxLimit?: number
  querySchema?: TQuerySchema
  table: TTable
  where?: (context: {
    query: QueryOutput<TQuerySchema>
    table: TTable
  }) => { getSQL(): unknown } | undefined
}

type CollectionTransform<TTable extends DrizzleTable> =
  (row: NoInfer<TTable["$inferSelect"]>) => unknown

type KeysetCursor = readonly (boolean | null | number | string)[]

const keysetCursorSchema: StandardSchemaV1<KeysetCursor> = {
  "~standard": {
    version: 1,
    vendor: "vite-hub",
    validate(value) {
      return Array.isArray(value) && value.length === 2 && value.every(isCursorScalar)
        ? { value: value as unknown as KeysetCursor }
        : { issues: [{ message: "Collection keyset cursor is malformed." }] }
    },
  },
}

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

function columnKey(table: SQLiteTable, column: AnySQLiteColumn): string {
  const entry = Object.entries(getTableColumns(table))
    .find(([, candidate]) => candidate === column)
  if (!entry) {
    throw new TypeError("[vitehub] Collection keyset columns must belong to its table.")
  }
  return entry[0]
}

function driverValue(column: AnySQLiteColumn, value: unknown): boolean | null | number | string {
  const encoded = column.mapToDriverValue(value)
  if (!isCursorScalar(encoded)) {
    throw new TypeError("[vitehub] Collection keyset columns must encode as scalar values.")
  }
  return encoded
}

function keysetWhere(
  columns: readonly AnySQLiteColumn[],
  cursor: KeysetCursor,
  order: "asc" | "desc",
): SQL | undefined {
  const compare = order === "asc" ? gt : lt
  return or(...columns.map((column, index) => and(
    ...columns.slice(0, index).map((previous, previousIndex) =>
      eq(previous, previous.mapFromDriverValue(cursor[previousIndex])),
    ),
    compare(column, column.mapFromDriverValue(cursor[index])),
  )))
}

export function defineDrizzleCollection<
  TSchema extends Record<string, unknown>,
  TTable extends DrizzleTable,
  TQuerySchema extends StandardSchemaV1<unknown, object>,
  TTransform extends CollectionTransform<TTable>,
>(options: DrizzleCollectionOptions<TSchema, TTable, TQuerySchema> & {
  querySchema: TQuerySchema
  transform: TTransform
}): Collection<Awaited<ReturnType<TTransform>>, StandardSchemaV1.InferOutput<TQuerySchema>>
export function defineDrizzleCollection<
  TSchema extends Record<string, unknown>,
  TTable extends DrizzleTable,
  TQuerySchema extends StandardSchemaV1<unknown, object>,
>(options: DrizzleCollectionOptions<TSchema, TTable, TQuerySchema> & {
  querySchema: TQuerySchema
  transform?: undefined
}): Collection<TTable["$inferSelect"], StandardSchemaV1.InferOutput<TQuerySchema>>
export function defineDrizzleCollection<
  TSchema extends Record<string, unknown>,
  TTable extends DrizzleTable,
  TTransform extends CollectionTransform<TTable>,
>(options: DrizzleCollectionOptions<TSchema, TTable> & {
  querySchema?: undefined
  transform: TTransform
}): Collection<Awaited<ReturnType<TTransform>>, CollectionRequestQuery>
export function defineDrizzleCollection<
  TSchema extends Record<string, unknown>,
  TTable extends DrizzleTable,
>(options: DrizzleCollectionOptions<TSchema, TTable> & {
  querySchema?: undefined
  transform?: undefined
}): Collection<TTable["$inferSelect"], CollectionRequestQuery>
export function defineDrizzleCollection(input: unknown): unknown {
  const options = input as DrizzleCollectionOptions<
    Record<string, unknown>,
    DrizzleTable,
    StandardSchemaV1<unknown, object> | undefined
  > & {
    transform?: CollectionTransform<DrizzleTable>
  }
  const table = options.table as unknown as SQLiteTable
  const columns = [options.keyset.by, options.keyset.tieBreaker] as AnySQLiteColumn[]
  const keys = columns.map(column => columnKey(table, column))

  for (const column of columns) {
    if (!column.notNull) {
      throw new TypeError("[vitehub] Collection keyset columns must be non-null.")
    }
  }
  const tieBreaker = columns[1]!
  if (!tieBreaker.primary && !tieBreaker.isUnique) {
    throw new TypeError("[vitehub] Collection keyset tieBreaker must be unique.")
  }

  const order = options.keyset.order
  const orderBy = columns.map(column => order === "asc" ? asc(column) : desc(column))
  const querySchema = (options.querySchema ?? requestQuerySchema) as StandardSchemaV1<unknown, object>
  const load = async ({ cursor, limit, query }: {
    cursor?: KeysetCursor
    limit: number
    query: object
  }) => {
    const filter = options.where?.({
      query,
      table: options.table,
    }) as SQL | undefined
    const after = cursor ? keysetWhere(columns, cursor, order) : undefined
    return await options.db
      .select()
      .from(table)
      .where(and(filter, after))
      .orderBy(...orderBy)
      .limit(limit) as DrizzleTable["$inferSelect"][]
  }
  const definition = {
    cursor: (row: DrizzleTable["$inferSelect"]): KeysetCursor =>
      columns.map((column, index) => driverValue(column, row[keys[index]!])),
    cursorSchema: keysetCursorSchema,
    defaultLimit: options.defaultLimit,
    maxLimit: options.maxLimit,
    querySchema,
  }

  const collection = options.transform
    ? defineCollection(load, { ...definition, transform: options.transform })
    : defineCollection(load, definition)
  return collection
}
