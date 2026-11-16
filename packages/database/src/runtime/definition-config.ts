import definitionDefaults from "#vitehub/database/definition-defaults"
import { resolveDevRemoteConfig, resolveRuntimeCloudflareConfig } from "../internal/cloudflare.ts"

import type { CloudflareD1Projection, DatabaseDefinition, RuntimeDrizzleDatabaseConfig } from "../types.ts"

interface DatabaseDefinitionDefaults {
  cloudflare?: DatabaseDefinition["cloudflare"]
  cloudflareProjections?: Record<string, CloudflareD1Projection>
  connection?: DatabaseDefinition["connection"]
  /** Set only in defaults generated for `vite dev`, where `remote` applies. */
  dev?: true
}

/** The local SQLite file of a Definition without `connection.url`. */
export function defaultUrl(name: string) {
  if (name === "default") return "file:.vitehub/data/database/sqlite.db"
  return `file:.vitehub/data/database/${name}.sqlite.db`
}

export function runtimeConfig(
  definition: Pick<DatabaseDefinition, "cloudflare" | "connection" | "name" | "remote">,
  defaults: DatabaseDefinitionDefaults = definitionDefaults,
): RuntimeDrizzleDatabaseConfig {
  const cloudflare = resolveRuntimeCloudflareConfig(defaults.cloudflare, definition.cloudflare, {
    ...defaults.cloudflareProjections?.[definition.name],
    name: definition.name,
  })
  const config: RuntimeDrizzleDatabaseConfig = {
    connection: {
      authToken: definition.connection?.authToken ?? defaults.connection?.authToken,
      url: definition.connection?.url ?? defaults.connection?.url ?? defaultUrl(definition.name),
    },
    name: definition.name,
  }
  if (cloudflare) config.cloudflare = cloudflare
  return defaults.dev ? resolveDevRemoteConfig(config, definition.remote) : config
}
