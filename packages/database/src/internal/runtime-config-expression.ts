import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"

function getDefaultCloudflareBindingName(name: string) {
  if (name === "default") return "DB"
  const suffix = name
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toUpperCase()
  return `DB_${suffix || "DATABASE"}`
}

function renderConfigExpression(value: unknown) {
  return typeof value === "undefined" ? "undefined" : JSON.stringify(value)
}

function serializeDatabaseConfig({ cloudflare: _cloudflare, connection: _connection, drizzle: _drizzle, ...database }: ResolvedDrizzleDatabaseConfig) {
  return JSON.stringify(database, null, 4)
}

export function renderDatabaseConfigExpression(name: string, config: ResolvedDBViteConfig, definitionVariable: string) {
  const base = config.databases[name]!
  const definitionCloudflareDefaults = config.definitionDefaults.cloudflare
    ? {
        ...config.definitionDefaults.cloudflare,
        binding: config.definitionDefaults.cloudflare.binding ?? base.cloudflare?.binding ?? getDefaultCloudflareBindingName(name),
      }
    : undefined
  const baseHttp = base.cloudflare?.http
  const baseHttpConfig = baseHttp && baseHttp !== true ? baseHttp : undefined
  const http = `${definitionVariable}.cloudflare.http === true ? true : ${definitionVariable}.cloudflare.http ? { authToken: ${definitionVariable}.cloudflare.http.authToken ?? ${renderConfigExpression(baseHttpConfig?.authToken)}, url: ${definitionVariable}.cloudflare.http.url ?? ${renderConfigExpression(baseHttpConfig?.url)} } : ${renderConfigExpression(baseHttp)}`
  return [
    "{",
    `      ...${serializeDatabaseConfig(base)},`,
    `      cloudflare: ${definitionVariable}.cloudflare ? { binding: ${definitionVariable}.cloudflare.binding ?? ${JSON.stringify(base.cloudflare?.binding ?? getDefaultCloudflareBindingName(name))}, databaseId: ${definitionVariable}.cloudflare.databaseId, databaseName: ${definitionVariable}.cloudflare.databaseName, http: ${http}, migrationsDir: ${JSON.stringify(base.migrationsDir)}, migrationsTable: ${definitionVariable}.cloudflare.migrationsTable, previewDatabaseId: ${definitionVariable}.cloudflare.previewDatabaseId } : ${renderConfigExpression(definitionCloudflareDefaults)},`,
    `      connection: ${definitionVariable}.connection ? { authToken: ${definitionVariable}.connection.authToken ?? ${renderConfigExpression(base.connection?.authToken)}, url: ${definitionVariable}.connection.url ?? ${renderConfigExpression(base.connection?.url)} } : ${renderConfigExpression(base.connection)},`,
    `      drizzle: ${definitionVariable}.drizzle ?? {},`,
    "    }",
  ].join("\n")
}
