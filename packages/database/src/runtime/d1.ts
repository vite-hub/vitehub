import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { runtimeConfig } from "./definition-config.ts"

import type { AnyRelations } from "drizzle-orm"
import type { DatabaseDefinition, RuntimeDrizzleDatabaseConfig } from "../types.ts"

export { resolveDevRemoteConfig, resolveRuntimeCloudflareConfig } from "../internal/cloudflare.ts"

const options = {
  missingConnection: "a Cloudflare D1 binding or `cloudflare.http`",
  requireRemoteUrl: true,
}

export function createHostedDrizzleDb<TRelations extends AnyRelations>(
  config: RuntimeDrizzleDatabaseConfig,
  relations: TRelations,
) {
  return createDrizzleSqliteAdapter<Record<string, unknown>, TRelations>(config, relations, options)
}

export function createDefinitionRuntime<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  definition: DatabaseDefinition<TSchema, TRelations>,
) {
  return createDrizzleSqliteAdapter<TSchema, TRelations>(runtimeConfig(definition), definition.relations, options)
}
