// `authDatabase()` connects Better Auth to a ViteHub Database. The Auth Vite plugin finds the call in the Auth
// Definition and adds the Better Auth tables to that Database, so `vitehub database generate` writes their migration.
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2"
import { databases } from "@vite-hub/database/runtime/registry"
import { getAuthTables } from "better-auth/db"
import { getTableColumns, is, isTable } from "drizzle-orm"
import { PgAsyncDatabase } from "drizzle-orm/pg-core"

import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { assertAuthDatabaseIdStrategy, authDatabaseSchemaError } from "./database-options.ts"
import { assertAuthDatabaseNames } from "./database-schema-options.ts"

import type { BetterAuthOptions } from "better-auth"
import type { AuthAppDatabase } from "./types.ts"

export type { AuthAppDatabase } from "./types.ts"

/**
 * Compares the tables and fields that the options need, with the plugins and additional fields, against the Drizzle
 * tables of the Database, before the adapter opens it.
 */
function assertAuthDatabaseSchema(options: BetterAuthOptions, schema: Readonly<Record<string, unknown>>, database: string): void {
  const fix = "Import the plugin by name from its package, such as `import { admin } from \"better-auth/plugins\"`, and call it in `server/auth.ts` or in a file that it imports with a relative path. Auth does not read a default import of the plugin, or a namespace that a local file re-exports. Write `additionalFields` inline in `server/auth.ts`, so that the Auth Vite plugin adds the columns. Then run `vitehub database generate` and apply the migration"
  for (const [model, table] of Object.entries(getAuthTables(options))) {
    const drizzleTable = Object.hasOwn(schema, model) ? schema[model] : undefined
    if (!isTable(drizzleTable)) throw authDatabaseSchemaError(`the ${JSON.stringify(database)} Database has no \`${model}\` table. ${fix}`)
    const columns = getTableColumns(drizzleTable)
    for (const key of Object.keys(table.fields)) {
      if (!Object.hasOwn(columns, key)) throw authDatabaseSchemaError(`the \`${model}\` table of the ${JSON.stringify(database)} Database has no \`${key}\` column. ${fix}`)
    }
  }
}

function readOwnRecord(value: unknown, key: string): object | undefined {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined
  const entry: unknown = Reflect.get(value, key)
  return typeof entry === "object" && entry !== null ? entry : undefined
}

function assertAuthDatabaseJoinRelations(options: BetterAuthOptions, db: unknown, schema: Readonly<Record<string, unknown>>, database: string): void {
  if (!options.advanced?.database?.joins) return
  const internal = readOwnRecord(db, "_")
  const relationMap = readOwnRecord(internal, "relations")
  const tables = getAuthTables(options)
  const hasRelation = (model: string, key: string): boolean => {
    const modelEntry = readOwnRecord(relationMap, model)
    const modelRelations = readOwnRecord(modelEntry, "relations")
    return Boolean(modelRelations && Object.hasOwn(modelRelations, key))
  }
  const missingRelationError = (model: string, key: string): Error => {
    const drizzleTable = Object.hasOwn(schema, model) ? schema[model] : undefined
    const columns = isTable(drizzleTable) ? getTableColumns(drizzleTable) : undefined
    if (columns && Object.hasOwn(columns, key)) {
      return authDatabaseSchemaError(`the \`${model}\` table of the ${JSON.stringify(database)} Database has no \`${key}\` relation for \`advanced.database.joins\`, because its \`${key}\` column collides with that relation name. Rename the column or turn off \`advanced.database.joins\``)
    }
    return authDatabaseSchemaError(`the \`${model}\` table of the ${JSON.stringify(database)} Database has no \`${key}\` relation for \`advanced.database.joins\`. Contribute the Auth relations to the Database or turn off \`advanced.database.joins\``)
  }
  const additionalFieldNames = (model: string): object | undefined => {
    const modelOptions = readOwnRecord(options, model)
    return readOwnRecord(modelOptions, "additionalFields")
  }
  for (const [model, table] of Object.entries(tables)) {
    const additional = additionalFieldNames(model)
    const targets = new Map<string, Array<{ unique: boolean }>>()
    for (const [fieldName, field] of Object.entries(table.fields)) {
      if (additional && Object.hasOwn(additional, fieldName)) continue
      const target = field.references?.model
      if (!target || !Object.hasOwn(tables, target)) continue
      const entries = targets.get(target) ?? []
      entries.push({ unique: Boolean(field.unique) })
      targets.set(target, entries)
    }
    for (const [target, references] of targets) {
      if (references.length !== 1) continue
      if (!hasRelation(model, target)) throw missingRelationError(model, target)
      const reverseKey = references[0]!.unique ? model : model.endsWith("s") ? model : `${model}s`
      if (!hasRelation(target, reverseKey)) throw missingRelationError(target, reverseKey)
    }
  }
}

/**
 * The Better Auth `database` adapter for the app Database `name` (default `"default"`). Pass it inline as the
 * `database` of `defineAuth()`. Auth then adds the Better Auth tables, the fields of `admin()` when the Definition calls it, the
 * Console MCP OAuth tables, the table of Better Auth's limiter, the `additionalFields` of the Definition, and the tables of
 * the plugins that it calls, such as `twoFactor()` and `apiKey()`, to that Database. The adapter uses the Database of each
 * request: SQLite, libSQL, Cloudflare D1, or Postgres.
 */
export function authDatabase(name: string = "default"): AuthAppDatabase {
  const adapter = (options: Parameters<AuthAppDatabase>[0]): ReturnType<AuthAppDatabase> => {
    assertAuthDatabaseIdStrategy(options.advanced?.database?.generateId)
    assertAuthDatabaseNames(options)
    const entry = Object.hasOwn(databases, name) ? databases[name] : undefined
    if (!entry || !Object.hasOwn(entry.schema, "user")) {
      throw authErrorDiagnostics.AUTH_R0019({ message: `[vitehub] \`authDatabase(${JSON.stringify(name)})\` found no Better Auth tables in the ${JSON.stringify(name)} Database. Pass \`authDatabase()\` inline as the \`database\` of \`defineAuth()\` so that Auth adds them, enable the Database integration, and run \`vitehub database generate\`. \`vitehub inspect definitions --kind database\` lists the tables of each Database.` })
    }
    assertAuthDatabaseSchema(options, entry.schema, name)
    assertAuthDatabaseJoinRelations(options, entry.db, entry.schema, name)
    return drizzleAdapter(entry.db, { provider: is(entry.db, PgAsyncDatabase) ? "pg" : "sqlite", schema: entry.schema })(options)
  }
  return Object.assign(adapter, { vitehubDatabase: name })
}
