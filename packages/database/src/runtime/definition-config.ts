import definitionDefaults from "#vitehub/database/definition-defaults"

import type { DatabaseDefinition, RuntimeDrizzleDatabaseConfig } from "../types.ts"

interface DatabaseDefinitionDefaults {
  cloudflare?: DatabaseDefinition["cloudflare"]
  connection?: DatabaseDefinition["connection"]
}

function defaultBinding(name: string) {
  if (name === "default") return "DB"
  const suffix = name.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_").toUpperCase()
  return `DB_${suffix || "DATABASE"}`
}

function defaultUrl(name: string) {
  if (name === "default") return "file:.vitehub/data/database/sqlite.db"
  return `file:.vitehub/data/database/${name}.sqlite.db`
}

export function runtimeConfig(
  definition: DatabaseDefinition,
  defaults: DatabaseDefinitionDefaults = definitionDefaults,
): RuntimeDrizzleDatabaseConfig {
  const cloudflare = definition.cloudflare ?? defaults.cloudflare
  return {
    ...(cloudflare
      ? { cloudflare: { ...cloudflare, binding: cloudflare.binding || defaultBinding(definition.name) } }
      : {}),
    connection: {
      authToken: definition.connection?.authToken ?? defaults.connection?.authToken,
      url: definition.connection?.url ?? defaults.connection?.url ?? defaultUrl(definition.name),
    },
    drizzle: definition.drizzle,
    name: definition.name,
  }
}
