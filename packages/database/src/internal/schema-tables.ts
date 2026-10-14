import { is, Table, View } from "drizzle-orm"
import { createJiti } from "jiti"

import { readStaticDatabaseSchema } from "../config.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

export interface DatabaseTableNameOptions {
  /** Import aliases the host applies to the Database Definition, such as Vite `resolve.alias`. */
  alias?: Record<string, string>
  /**
   * Receives a warning when the Database Definition cannot load, and switches to the keys of its literal
   * `schema: { ... }` object. Without it, a Definition that cannot load throws.
   */
  onFallback?: (message: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Loads a Database Definition and lists the schema keys that hold Drizzle tables or views.
 * The schema value is evaluated, so imported, spread, and namespace schemas list every table.
 */
export async function loadDatabaseTableNames(handler: string, options: DatabaseTableNameOptions = {}): Promise<string[]> {
  let failure: { code: "DATABASE_B0007" | "DATABASE_B0008", error?: unknown, message: string }
  try {
    // Read only `default.schema`. Awaiting the Definition itself would probe `then` and connect its database.
    const loader = createJiti(import.meta.url, { alias: options.alias, fsCache: false, interopDefault: false, moduleCache: false })
    const module = await loader.import<{ default?: unknown }>(handler)
    const schema = isRecord(module.default) ? module.default.schema : undefined
    if (isRecord(schema)) return Object.keys(schema).filter(key => is(schema[key], Table) || is(schema[key], View))
    failure = { code: "DATABASE_B0008", message: `[vitehub] Database Definition "${handler}" must default export \`defineDatabase({ schema })\` with a schema object.` }
  }
  catch (error) {
    failure = { code: "DATABASE_B0007", error, message: `[vitehub] Database Definition "${handler}" could not load to list its tables: ${errorMessage(error)}` }
  }

  if (!options.onFallback) throw databaseErrorDiagnostics[failure.code]({ cause: failure.error, message: failure.message })
  options.onFallback(`${failure.message.replace(/\.?$/, ".")} Using the keys of its literal \`schema: { ... }\` object instead. \`vitehub db generate\` requires the Definition to load.`)
  return readStaticDatabaseSchema(handler).tableNames
}
