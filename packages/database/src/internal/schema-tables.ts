import { isPlainObject } from "@vite-hub/internal/object"

import { describeDatabaseContribution } from "../contributions.ts"
import { readStaticDatabaseSchema } from "../config.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

import type { CollectedDatabaseContribution } from "../contributions.ts"

export interface DatabaseTableNameOptions {
  /** Import aliases the host applies to the Database Definition, such as Vite `resolve.alias`. */
  alias?: Record<string, string>
  /**
   * Receives a warning when the Database Definition cannot load, and switches to the keys of its literal
   * `schema: { ... }` object. Without it, a Definition that cannot load throws.
   */
  onFallback?: (message: string) => void
}

/** The keys of an evaluated schema object. */
export interface LoadedDatabaseSchema {
  /** False when the schema could not load and only its literal keys are known. */
  loaded: boolean
  /** Every key of the schema object, including relations. */
  keys: string[]
  /** Keys that hold Drizzle tables or views. The generated schema exports each one. */
  tableNames: string[]
  /** SQL name of each table or view key. Empty when the schema did not load. */
  sqlNames: Map<string, string>
}

/** Reject duplicate schema keys or SQL table names before schemas are merged. */
export function assertDistinctLoadedSchemas(database: string, parts: readonly { schema: LoadedDatabaseSchema, owner: string }[]) {
  const keys = new Map<string, string>()
  const sqlNames = new Map<string, string>()
  for (const part of parts) {
    for (const key of part.schema.keys) {
      const existing = keys.get(key)
      if (existing) throw databaseErrorDiagnostics.DATABASE_DUPLICATE_TABLE({ database, first: existing, kind: "schema key", name: key, second: part.owner })
      keys.set(key, part.owner)
    }
    for (const sqlName of part.schema.sqlNames.values()) {
      const existing = sqlNames.get(sqlName)
      if (existing) throw databaseErrorDiagnostics.DATABASE_DUPLICATE_TABLE({ database, first: existing, kind: "table", name: sqlName, second: part.owner })
      sqlNames.set(sqlName, part.owner)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// Importing the Vite plugin must stay cheap, so Drizzle and jiti load only when a schema is evaluated.
type DrizzleSchemaTools = Awaited<ReturnType<typeof importDrizzleSchemaTools>>

async function importDrizzleSchemaTools() {
  const [{ getTableName, is, Table, View }, { getViewConfig, SQLiteView }] = await Promise.all([
    import("drizzle-orm"),
    import("drizzle-orm/sqlite-core"),
  ])
  const isTableOrView = (value: unknown) => is(value, Table) || is(value, View)
  const sqlName = (value: unknown) => {
    if (is(value, Table)) return getTableName(value)
    if (is(value, SQLiteView)) return getViewConfig(value).name
  }
  return { isTableOrView, sqlName }
}

let drizzleSchemaTools: Promise<DrizzleSchemaTools> | undefined

function loadDrizzleSchemaTools() {
  drizzleSchemaTools ??= importDrizzleSchemaTools()
  return drizzleSchemaTools
}

async function describeSchema(schema: Record<string, unknown>): Promise<LoadedDatabaseSchema> {
  const { isTableOrView, sqlName } = await loadDrizzleSchemaTools()
  const keys = Object.keys(schema)
  const tableNames = keys.filter(key => isTableOrView(schema[key]))
  const sqlNames = new Map(tableNames.flatMap((key) => {
    const name = sqlName(schema[key])
    return name ? [[key, name] as const] : []
  }))
  return { keys, loaded: true, sqlNames, tableNames }
}

async function createLoader(parent: string, alias: Record<string, string> | undefined) {
  const { createJiti } = await import("jiti")
  // Read only the requested export. Awaiting a Definition itself would probe `then` and connect its database.
  return createJiti(parent, { alias, fsCache: false, interopDefault: false, moduleCache: false })
}

/**
 * Loads a Database Definition and lists its schema keys. The schema value is evaluated, so imported, spread, and
 * namespace schemas list every table.
 */
export async function loadDatabaseSchema(handler: string, options: DatabaseTableNameOptions = {}): Promise<LoadedDatabaseSchema> {
  let failure: Error
  try {
    const module = await (await createLoader(import.meta.url, options.alias)).import<{ default?: unknown }>(handler)
    const schema = isRecord(module.default) ? module.default.schema : undefined
    if (isRecord(schema)) return await describeSchema(schema)
    failure = databaseErrorDiagnostics.DATABASE_INVALID_SCHEMA_EXPORT({ handler })
  }
  catch (error) {
    failure = databaseErrorDiagnostics.DATABASE_SCHEMA_LOAD_FAILED({ cause: error, problem: errorMessage(error), source: `The Database Definition "${handler}"` })
  }

  if (!options.onFallback) throw failure
  options.onFallback(`[vitehub] ${failure.message.replace(/\.?$/, ".")} Using the keys of its literal \`schema: { ... }\` object instead. \`vitehub db generate\` requires the Definition to load.`)
  const { tableNames } = readStaticDatabaseSchema(handler)
  return { keys: tableNames, loaded: false, sqlNames: new Map(), tableNames }
}

/** Merges schema sources in order. A later source wins a key. */
export function mergeLoadedSchemas(schemas: readonly LoadedDatabaseSchema[]): LoadedDatabaseSchema {
  if (schemas.length === 1) return schemas[0]!
  const owners = new Map<string, LoadedDatabaseSchema>()
  for (const schema of schemas) {
    for (const key of schema.keys) owners.set(key, schema)
  }
  const keys = [...owners.keys()]
  const tableNames = keys.filter(key => owners.get(key)!.tableNames.includes(key))
  const sqlNames = new Map(tableNames.flatMap((key) => {
    const name = owners.get(key)!.sqlNames.get(key)
    return name ? [[key, name] as const] : []
  }))
  return { keys, loaded: schemas.every(schema => schema.loaded), sqlNames, tableNames }
}

/** Lists the schema keys of a Database Definition that hold Drizzle tables or views. */
export async function loadDatabaseTableNames(handler: string, options: DatabaseTableNameOptions = {}): Promise<string[]> {
  return (await loadDatabaseSchema(handler, options)).tableNames
}

/**
 * Loads the tables of a contribution. `parent` is the file that imports the contribution, so package specifiers
 * resolve from the application. A missing or non-object export fails with `DATABASE_INVALID_CONTRIBUTION`. A module
 * that cannot load fails with `DATABASE_SCHEMA_LOAD_FAILED`, unless `onFallback` accepts it; its tables are then known only at runtime.
 */
export async function loadContributedDatabaseSchema(
  contribution: CollectedDatabaseContribution,
  parent: string,
  options: DatabaseTableNameOptions = {},
): Promise<LoadedDatabaseSchema> {
  const source = describeDatabaseContribution(contribution)
  let module: Record<string, unknown>
  try {
    module = await (await createLoader(parent, options.alias)).import<Record<string, unknown>>(contribution.definition.module)
  }
  catch (error) {
    const failure = databaseErrorDiagnostics.DATABASE_SCHEMA_LOAD_FAILED({ cause: error, problem: errorMessage(error), source: `Contributed Database tables ${source}` })
    if (!options.onFallback) throw failure
    options.onFallback(`[vitehub] ${failure.message.replace(/\.?$/, ".")} Their tables are not exported for drizzle-kit. \`vitehub db generate\` requires the module to load.`)
    return { keys: [], loaded: false, sqlNames: new Map(), tableNames: [] }
  }
  const exportName = contribution.definition.export
  const schema = module[exportName]
  const { isTableOrView } = await loadDrizzleSchemaTools()
  if (!isRecord(schema) || Array.isArray(schema) || isTableOrView(schema)) {
    throw databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION({ problem: `Contributed Database tables ${source} need ${exportName === "default" ? "a default export" : `the export ${JSON.stringify(exportName)}`} that holds an object of Drizzle tables.` })
  }
  return await describeSchema(schema)
}
