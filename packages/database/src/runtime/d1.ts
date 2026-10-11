import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { runtimeConfig } from "./definition-config.ts"

import type { DatabaseDefinition, RuntimeDrizzleDatabaseConfig } from "../types.ts"

export { resolveRuntimeCloudflareConfig } from "../internal/cloudflare.ts"

const options = {
  missingConnectionMessage: (config: RuntimeDrizzleDatabaseConfig) => `[vitehub] D1 database "${config.name}" requires a Cloudflare binding or cloudflare.http configuration.`,
  requireRemoteUrl: true,
}

export function createHostedDrizzleDb<TSchema extends Record<string, unknown>>(
  config: RuntimeDrizzleDatabaseConfig,
  schema: TSchema,
) {
  return createDrizzleSqliteAdapter(config, schema, options)
}

export function createDefinitionRuntime<TSchema extends Record<string, unknown>>(
  definition: DatabaseDefinition<TSchema>,
) {
  return createHostedDrizzleDb(runtimeConfig(definition), definition.schema)
}
