import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import { createClient } from "@libsql/client"
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql"

import { createDrizzleSqliteAdapter, isRemoteSqliteUrl } from "./drizzle-adapter.ts"
import { runtimeConfig } from "./definition-config.ts"

import type { DatabaseDefinition, RuntimeDrizzleDatabase } from "../types.ts"

function resolveLocalUrl(url: string) {
  if (url === ":memory:" || isRemoteSqliteUrl(url)) return url
  const path = url.startsWith("file:") ? url.slice("file:".length) : url
  mkdirSync(dirname(path), { recursive: true })
  return url
}

export function createDefinitionRuntime<TSchema extends Record<string, unknown>>(
  definition: DatabaseDefinition<TSchema>,
  defaults?: Pick<DatabaseDefinition, "cloudflare" | "connection">,
): RuntimeDrizzleDatabase<TSchema> {
  return createDrizzleSqliteAdapter(runtimeConfig(definition, defaults), definition.schema, {
    libsql: { createClient, drizzle: drizzleLibsql as never },
    missingConnectionMessage: config => `[vitehub] Database "${config.name}" requires a Cloudflare D1 binding or database connection URL.`,
    requireRemoteUrl: false,
    resolveLocalUrl,
  })
}
