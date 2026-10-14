import { getTableName, is, Table, View } from "drizzle-orm"
import { getViewConfig, SQLiteView } from "drizzle-orm/sqlite-core"
import { createJiti } from "jiti"

import { describeDatabaseContribution } from "../contributions.ts"
import { readStaticDatabaseSchema } from "../config.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

import type { DatabaseContribution } from "../contributions.ts"

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function sqlName(value: unknown) {
  if (is(value, Table)) return getTableName(value)
  if (is(value, SQLiteView)) return getViewConfig(value).name
}

function describeSchema(schema: Record<string, unknown>): LoadedDatabaseSchema {
  const keys = Object.keys(schema)
  const tableNames = keys.filter(key => is(schema[key], Table) || is(schema[key], View))
  const sqlNames = new Map(tableNames.flatMap((key) => {
    const name = sqlName(schema[key])
    return name ? [[key, name] as const] : []
  }))
  return { keys, loaded: true, sqlNames, tableNames }
}

function createLoader(parent: string, alias: Record<string, string> | undefined) {
  // Read only the requested export. Awaiting a Definition itself would probe `then` and connect its database.
  return createJiti(parent, { alias, fsCache: false, interopDefault: false, moduleCache: false })
}

/**
 * Loads a Database Definition and lists its schema keys. The schema value is evaluated, so imported, spread, and
 * namespace schemas list every table.
 */
export async function loadDatabaseSchema(handler: string, options: DatabaseTableNameOptions = {}): Promise<LoadedDatabaseSchema> {
  let failure: { code: "DATABASE_B0007" | "DATABASE_B0008", error?: unknown, message: string }
  try {
    const module = await createLoader(import.meta.url, options.alias).import<{ default?: unknown }>(handler)
    const schema = isRecord(module.default) ? module.default.schema : undefined
    if (isRecord(schema)) return describeSchema(schema)
    failure = { code: "DATABASE_B0008", message: `[vitehub] Database Definition "${handler}" must default export \`defineDatabase({ schema })\` with a schema object.` }
  }
  catch (error) {
    failure = { code: "DATABASE_B0007", error, message: `[vitehub] Database Definition "${handler}" could not load to list its tables: ${errorMessage(error)}` }
  }

  if (!options.onFallback) throw databaseErrorDiagnostics[failure.code]({ cause: failure.error, message: failure.message })
  options.onFallback(`${failure.message.replace(/\.?$/, ".")} Using the keys of its literal \`schema: { ... }\` object instead. \`vitehub db generate\` requires the Definition to load.`)
  const { tableNames } = readStaticDatabaseSchema(handler)
  return { keys: tableNames, loaded: false, sqlNames: new Map(), tableNames }
}

/** Lists the schema keys of a Database Definition that hold Drizzle tables or views. */
export async function loadDatabaseTableNames(handler: string, options: DatabaseTableNameOptions = {}): Promise<string[]> {
  return (await loadDatabaseSchema(handler, options)).tableNames
}

/**
 * Loads the tables of a contribution. `parent` is the file that imports the contribution, so package specifiers
 * resolve from the application. A missing or non-object export fails with `DATABASE_B0012`. A module that cannot
 * load fails with `DATABASE_B0007`, unless `onFallback` accepts it; its tables are then known only at runtime.
 */
export async function loadContributedDatabaseSchema(
  contribution: DatabaseContribution & { contributor?: string },
  parent: string,
  options: DatabaseTableNameOptions = {},
): Promise<LoadedDatabaseSchema> {
  const source = describeDatabaseContribution(contribution)
  let module: Record<string, unknown>
  try {
    module = await createLoader(parent, options.alias).import<Record<string, unknown>>(contribution.module)
  }
  catch (error) {
    const message = `[vitehub] Contributed Database tables ${source} could not load: ${errorMessage(error)}`
    if (!options.onFallback) throw databaseErrorDiagnostics.DATABASE_B0007({ cause: error, message })
    options.onFallback(`${message.replace(/\.?$/, ".")} Their tables are not exported for drizzle-kit. \`vitehub db generate\` requires the module to load.`)
    return { keys: [], loaded: false, sqlNames: new Map(), tableNames: [] }
  }
  const exportName = contribution.export ?? "default"
  const schema = module[exportName]
  if (!isRecord(schema) || Array.isArray(schema) || is(schema, Table) || is(schema, View)) {
    throw databaseErrorDiagnostics.DATABASE_B0012({ message: `[vitehub] Contributed Database tables ${source} need ${exportName === "default" ? "a default export" : `the export ${JSON.stringify(exportName)}`} that holds an object of Drizzle tables.` })
  }
  return describeSchema(schema)
}
