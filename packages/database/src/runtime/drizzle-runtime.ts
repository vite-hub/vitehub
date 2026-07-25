import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import { createClient } from "@libsql/client"
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql"

import databaseEntries from "#vitehub/database/databases"

import {
  createDrizzleSqliteAdapter,
  isRemoteSqliteUrl,
} from "./drizzle-adapter.ts"

import type { ResolvedDrizzleDatabaseConfig, RuntimeDrizzleDatabase } from "../types.ts"

function resolveLocalSqliteUrl(url: string) {
  if (url === ":memory:" || isRemoteSqliteUrl(url)) {
    return url
  }

  const path = url.startsWith("file:") ? url.slice("file:".length) : url
  mkdirSync(dirname(path), { recursive: true })
  return url
}

interface RuntimeDatabaseModule {
  config: ResolvedDrizzleDatabaseConfig
  schema: Record<string, unknown>
}

interface RuntimeDatabaseEntry<TSchema extends Record<string, unknown>> {
  db: RuntimeDrizzleDatabase<TSchema>
  schema: TSchema
}

function createMissingDatabaseProxy<TSchema extends Record<string, unknown>>(name: string) {
  return new Proxy({} as RuntimeDrizzleDatabase<TSchema>, {
    get() {
      throw new Error(name === "default"
        ? "[vitehub] `@vite-hub/database/drizzle` requires `hubDb()` and `database !== false`."
        : `[vitehub] Database "${name}" is not configured.`)
    },
  }) as RuntimeDrizzleDatabase<TSchema>
}

function createRuntimeDatabase<TSchema extends Record<string, unknown>>(
  config: ResolvedDrizzleDatabaseConfig | undefined,
  schema: TSchema,
  name: string,
) {
  if (!config) {
    return createMissingDatabaseProxy<TSchema>(name)
  }

  return createDrizzleSqliteAdapter(config, schema, {
    libsql: { createClient, drizzle: drizzleLibsql as never },
    missingConnectionMessage: () => `[vitehub] Database "${name}" requires a Cloudflare D1 binding or \`db.connection.url\`.`,
    requireRemoteUrl: false,
    resolveLocalUrl: resolveLocalSqliteUrl,
  })
}

const runtimeEntries = databaseEntries as Record<string, RuntimeDatabaseModule>

const resolvedDatabases = Object.fromEntries(
  Object.entries(runtimeEntries).map(([name, entry]) => [
    name,
    {
      db: createRuntimeDatabase(entry.config, entry.schema, name),
      schema: entry.schema,
    } satisfies RuntimeDatabaseEntry<Record<string, unknown>>,
  ]),
) as Record<string, RuntimeDatabaseEntry<Record<string, unknown>>> & {
  default: RuntimeDatabaseEntry<Record<string, unknown>>
}

const defaultDatabaseEntry = resolvedDatabases.default || {
  db: createMissingDatabaseProxy("default"),
  schema: {},
}

export const databases = {
  ...resolvedDatabases,
  default: defaultDatabaseEntry,
} as Record<string, RuntimeDatabaseEntry<Record<string, unknown>>> & {
  default: RuntimeDatabaseEntry<Record<string, unknown>>
}

export const db = databases.default.db
