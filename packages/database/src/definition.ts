import { isPlainObject } from "@vite-hub/internal/object"

import { createDefinitionRuntime } from "#vitehub/database/definition-runtime"

import type { Database, DatabaseDefinition, DatabaseDefinitionOptions, PostgresDatabaseDefinition, PostgresDatabaseDefinitionOptions } from "./types.ts"
import { databaseErrorDiagnostics } from "./error-diagnostics.ts"

const allowedDefinitionKeys = new Set(["cloudflare", "connection", "drizzle", "name", "schema"])
const allowedOptionKeys = new Set([...allowedDefinitionKeys, "dialect"])
const allowedPostgresKeys = {
  cloudflare: new Set(["binding", "hyperdriveId"]),
  connection: new Set(["url"]),
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw databaseErrorDiagnostics.DATABASE_INVALID_OPTIONS({ path: label })
  }
}

/** Declares a PostgreSQL Database Definition. Query it with `useDatabase()` from `@vite-hub/database/drizzle`. */
export function defineDatabase<TSchema extends Record<string, unknown>>(
  options: PostgresDatabaseDefinitionOptions<TSchema>,
): PostgresDatabaseDefinition<TSchema>
/** Declares a SQLite Database Definition for local SQLite, libSQL, or Cloudflare D1. */
export function defineDatabase<TSchema extends Record<string, unknown>>(
  options: DatabaseDefinitionOptions<TSchema>,
): Database<TSchema>
export function defineDatabase<TSchema extends Record<string, unknown>>(
  options: DatabaseDefinitionOptions<TSchema> | PostgresDatabaseDefinitionOptions<TSchema>,
): Database<TSchema> | PostgresDatabaseDefinition<TSchema> {
  assertPlainObject(options, "defineDatabase()")

  const unknownKey = Object.keys(options).find(key => !allowedOptionKeys.has(key))
  if (unknownKey) {
    throw databaseErrorDiagnostics.DATABASE_UNKNOWN_OPTION({ option: unknownKey })
  }

  const dialect = options.dialect ?? "sqlite"
  if (dialect !== "sqlite" && dialect !== "postgresql") {
    throw databaseErrorDiagnostics.DATABASE_INVALID_DIALECT({})
  }

  assertPlainObject(options.schema, "defineDatabase().schema")

  if (typeof options.cloudflare !== "undefined") {
    assertPlainObject(options.cloudflare, "defineDatabase().cloudflare")
    if ("http" in options.cloudflare && options.cloudflare.http !== true && options.cloudflare.http !== undefined) {
      assertPlainObject(options.cloudflare.http, "defineDatabase().cloudflare.http")
    }
  }
  if (typeof options.connection !== "undefined") {
    assertPlainObject(options.connection, "defineDatabase().connection")
  }
  if (typeof options.drizzle !== "undefined") {
    assertPlainObject(options.drizzle, "defineDatabase().drizzle")
  }

  const casing = options.drizzle?.casing
  if (typeof casing !== "undefined" && casing !== "snake_case" && casing !== "camelCase") {
    throw databaseErrorDiagnostics.DATABASE_INVALID_CASING()
  }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JavaScript callers can pass non-string names; reject them at the definition boundary before trim and normalized-path validation.
  if (options.name !== undefined && typeof options.name !== "string") {
    throw databaseErrorDiagnostics.DATABASE_C0007({ message: "`defineDatabase().name` must be a string." })
  }

  const name = options.name?.trim() || "default"
  if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i.test(name)) {
    throw databaseErrorDiagnostics.DATABASE_INVALID_NAME()
  }

  if (options.dialect === "postgresql") {
    const unsupported = [
      ...Object.keys(options.cloudflare ?? {}).filter(key => !allowedPostgresKeys.cloudflare.has(key)).map(key => `cloudflare.${key}`),
      ...Object.keys(options.connection ?? {}).filter(key => !allowedPostgresKeys.connection.has(key)).map(key => `connection.${key}`),
    ][0]
    if (unsupported) {
      throw databaseErrorDiagnostics.DATABASE_UNKNOWN_OPTION({ dialect: "postgresql", option: unsupported })
    }
    const postgresDefinition: PostgresDatabaseDefinition<TSchema> = {
      dialect: "postgresql",
      drizzle: casing ? { casing } : {},
      name,
      schema: options.schema,
    }
    if (options.cloudflare) postgresDefinition.cloudflare = options.cloudflare
    if (options.connection) postgresDefinition.connection = options.connection
    return postgresDefinition
  }

  const definition: DatabaseDefinition<TSchema> = {
    ...(options.cloudflare ? { cloudflare: options.cloudflare } : {}),
    ...(options.connection ? { connection: options.connection } : {}),
    drizzle: casing ? { casing } : {},
    name,
    schema: options.schema,
  }
  const runtime = createDefinitionRuntime(definition)

  return new Proxy(definition as Database<TSchema>, {
    get(target, property, receiver) {
      return Reflect.has(target, property) || (typeof property === "string" && allowedDefinitionKeys.has(property))
        ? Reflect.get(target, property, receiver)
        : Reflect.get(runtime, property)
    },
  })
}
