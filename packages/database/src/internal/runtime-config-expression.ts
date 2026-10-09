import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"

function renderConfigExpression(value: unknown) {
  return typeof value === "undefined" ? "undefined" : JSON.stringify(value)
}

function serializeDatabaseConfig({ cloudflare: _cloudflare, connection: _connection, drizzle: _drizzle, ...database }: ResolvedDrizzleDatabaseConfig) {
  return JSON.stringify(database, null, 4)
}

export function renderDatabaseConfigExpression(name: string, config: ResolvedDBViteConfig, definitionVariable: string) {
  const base = config.databases[name]!
  const cloudflare = base.cloudflare ?? config.definitionDefaults.cloudflare
  const cloudflareOptions = { ...config.definitionDefaults.cloudflareProjections?.[name], migrationsDir: base.migrationsDir, name }
  return [
    "{",
    `      ...${serializeDatabaseConfig(base)},`,
    `      cloudflare: resolveRuntimeCloudflareConfig(${renderConfigExpression(cloudflare)}, ${definitionVariable}.cloudflare, ${renderConfigExpression(cloudflareOptions)}),`,
    `      connection: ${definitionVariable}.connection ? { authToken: ${definitionVariable}.connection.authToken ?? ${renderConfigExpression(base.connection?.authToken)}, url: ${definitionVariable}.connection.url ?? ${renderConfigExpression(base.connection?.url)} } : ${renderConfigExpression(base.connection)},`,
    `      drizzle: ${definitionVariable}.drizzle ?? {},`,
    "    }",
  ].join("\n")
}
