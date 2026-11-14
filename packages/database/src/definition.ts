import { isPlainObject } from "@vite-hub/internal/object"
import { defineRelations } from "drizzle-orm"

import type { AnyRelations } from "drizzle-orm"
import type { DatabaseDefinition, DatabaseDefinitionOptions, PostgresDatabaseDefinition, PostgresDatabaseDefinitionOptions, SchemaRelations } from "./types.ts"
import { databaseErrorDiagnostics } from "./error-diagnostics.ts"

const allowedDefinitionKeys = new Set(["cloudflare", "connection", "name", "relations", "remote", "schema"])
const allowedOptionKeys = new Set([...allowedDefinitionKeys, "dialect", "driver"])
const allowedPostgresKeys = {
  cloudflare: new Set(["binding", "hyperdriveId"]),
  connection: new Set(["replicas", "url"]),
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw databaseErrorDiagnostics.DATABASE_INVALID_OPTIONS({ path: label })
  }
}

/** Declares a PostgreSQL Database Definition. Query it with `useDatabase()` from `vite-hub/database`. */
export function defineDatabase<TSchema extends Record<string, unknown>, TRelations extends AnyRelations = SchemaRelations<TSchema>>(
  options: PostgresDatabaseDefinitionOptions<TSchema, TRelations>,
): PostgresDatabaseDefinition<TSchema, TRelations>
/**
 * Declares a SQLite Database Definition for local SQLite, libSQL, or Cloudflare D1. Query it with `useDatabase()` from
 * `vite-hub/database`: the Definition is not a Drizzle database.
 */
export function defineDatabase<TSchema extends Record<string, unknown>, TRelations extends AnyRelations = SchemaRelations<TSchema>>(
  options: DatabaseDefinitionOptions<TSchema, TRelations>,
): DatabaseDefinition<TSchema, TRelations>
export function defineDatabase<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  options: DatabaseDefinitionOptions<TSchema, TRelations> | PostgresDatabaseDefinitionOptions<TSchema, TRelations>,
): DatabaseDefinition<TSchema, TRelations> | PostgresDatabaseDefinition<TSchema, TRelations> {
  assertPlainObject(options, "defineDatabase()")

  // Drizzle 1.0 has no database-wide casing, so a `drizzle.casing` that ViteHub ignored would map columns wrongly.
  if ("drizzle" in options) {
    throw databaseErrorDiagnostics.DATABASE_DRIZZLE_OPTION_REMOVED()
  }

  const unknownKey = Object.keys(options).find(key => !allowedOptionKeys.has(key))
  if (unknownKey) {
    throw databaseErrorDiagnostics.DATABASE_UNKNOWN_OPTION({ option: unknownKey })
  }

  const dialect = options.dialect ?? "sqlite"
  if (dialect !== "sqlite" && dialect !== "postgresql") {
    throw databaseErrorDiagnostics.DATABASE_INVALID_DIALECT({})
  }

  assertPlainObject(options.schema, "defineDatabase().schema")
  if (options.relations !== undefined) assertPlainObject(options.relations, "defineDatabase().relations")
  // SAFETY: Without `relations`, `TRelations` is its default, the relations of `schema`.
  const relations = options.relations ?? defineRelations(options.schema) as AnyRelations as TRelations

  if (typeof options.cloudflare !== "undefined") {
    assertPlainObject(options.cloudflare, "defineDatabase().cloudflare")
    if ("http" in options.cloudflare && options.cloudflare.http !== true && options.cloudflare.http !== undefined) {
      assertPlainObject(options.cloudflare.http, "defineDatabase().cloudflare.http")
    }
  }
  if (typeof options.connection !== "undefined") {
    assertPlainObject(options.connection, "defineDatabase().connection")
  }

  if (options.name !== undefined && typeof options.name !== "string") {
    throw databaseErrorDiagnostics.DATABASE_INVALID_NAME()
  }

  const name = options.name?.trim() || "default"
  if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i.test(name)) {
    throw databaseErrorDiagnostics.DATABASE_INVALID_NAME()
  }

  if (options.remote !== undefined && options.remote !== true && options.remote !== false) {
    throw databaseErrorDiagnostics.DATABASE_INVALID_REMOTE()
  }
  // `cloudflare.http` already sends `vite dev` to the remote database, so `remote: false` cannot keep it local.
  if (options.remote === false && options.cloudflare && "http" in options.cloudflare && options.cloudflare.http) {
    throw databaseErrorDiagnostics.DATABASE_REMOTE_CONFLICT({ database: name })
  }

  if (options.dialect !== "postgresql" && "driver" in options) {
    throw databaseErrorDiagnostics.DATABASE_UNKNOWN_OPTION({ option: "driver" })
  }

  if (options.dialect === "postgresql") {
    if (options.driver !== undefined && options.driver !== "pglite" && options.driver !== "node-postgres") {
      throw databaseErrorDiagnostics.DATABASE_INVALID_DRIVER({})
    }
    const unsupported = [
      ...options.remote === undefined ? [] : ["remote"],
      ...Object.keys(options.cloudflare ?? {}).filter(key => !allowedPostgresKeys.cloudflare.has(key)).map(key => `cloudflare.${key}`),
      ...Object.keys(options.connection ?? {}).filter(key => !allowedPostgresKeys.connection.has(key)).map(key => `connection.${key}`),
    ][0]
    if (unsupported) {
      throw databaseErrorDiagnostics.DATABASE_UNKNOWN_OPTION({ dialect: "postgresql", option: unsupported })
    }
    const postgresDefinition: PostgresDatabaseDefinition<TSchema, TRelations> = {
      dialect: "postgresql",
      name,
      relations,
      schema: options.schema,
    }
    if (options.cloudflare) postgresDefinition.cloudflare = options.cloudflare
    if (options.connection) postgresDefinition.connection = options.connection
    if (options.driver) postgresDefinition.driver = options.driver
    return postgresDefinition
  }

  return {
    ...(options.cloudflare ? { cloudflare: options.cloudflare } : {}),
    ...(options.connection ? { connection: options.connection } : {}),
    name,
    relations,
    ...(options.remote === undefined ? {} : { remote: options.remote }),
    schema: options.schema,
  }
}
