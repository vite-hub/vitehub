import type { DatabaseDefinition, RuntimeDrizzleDatabaseConfig } from "../types.ts"

function defaultBinding(name: string) {
  if (name === "default") return "DB"
  const suffix = name.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_").toUpperCase()
  return `DB_${suffix || "DATABASE"}`
}

function defaultUrl(name: string) {
  if (name === "default") return "file:.vitehub/data/database/sqlite.db"
  const filename = name.replace(/[^a-z0-9._-]+/gi, "-") || "database"
  return `file:.vitehub/data/database/${filename}.sqlite.db`
}

export function runtimeConfig(definition: DatabaseDefinition): RuntimeDrizzleDatabaseConfig {
  return {
    ...(definition.cloudflare
      ? { cloudflare: { ...definition.cloudflare, binding: definition.cloudflare.binding || defaultBinding(definition.name) } }
      : {}),
    connection: { ...definition.connection, url: definition.connection?.url ?? defaultUrl(definition.name) },
    drizzle: definition.drizzle,
    name: definition.name,
  }
}
