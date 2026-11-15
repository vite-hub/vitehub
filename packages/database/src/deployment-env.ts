import type { DeploymentEnvContext, DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"

import type { DatabaseConfigValue, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "./types.ts"

const owners = ["database"]

const localDatabase = /^(?:file:|:memory:$)/

/**
 * The entry of a config value that the server reads from env, such as `url: process.env.TURSO_DATABASE_URL`. A literal
 * reads no variable. A local SQLite default, such as the `file:` URL that ViteHub adds, keeps data only on a Node
 * server, so it does not count as a default on another host.
 */
function valueEntry(value: DatabaseConfigValue | undefined, required: boolean, host: DeploymentEnvContext["host"]): DeploymentEnvEntry[] {
  if (value === undefined || typeof value === "string") return []
  const names = value.source?.names ?? (value.source?.name ? [value.source.name] : [])
  if (!names.length) return []
  const fallback = value.default
  const hasDefault = fallback !== undefined && !(host !== "node" && typeof fallback === "string" && localDatabase.test(fallback))
  return [{ names, required: required && !hasDefault, secret: true, hasDefault, owners }]
}

function databaseEntries(database: ResolvedDrizzleDatabaseConfig, host: DeploymentEnvContext["host"]): DeploymentEnvEntry[] {
  // On Cloudflare, a D1 binding or a Hyperdrive binding holds the connection, so the server reads no variable.
  if (host === "cloudflare" && (database.cloudflare || database.hyperdrive)) return []
  const http = database.cloudflare?.http
  if (http === true) {
    return [
      { names: ["CLOUDFLARE_ACCOUNT_ID"], required: true, secret: false, hasDefault: false, owners },
      { names: ["CLOUDFLARE_API_TOKEN"], required: true, secret: true, hasDefault: false, owners },
      ...valueEntry(database.cloudflare?.databaseId, true, host),
    ]
  }
  if (http) return [...valueEntry(http.url, true, host), ...valueEntry(http.authToken, true, host)]
  const url = valueEntry(database.connection?.url, true, host)
  // A remote libSQL server, such as Turso, needs its token. A Node server may use a local sqld or file without one.
  const tokenRequired = database.dialect === "sqlite" && host !== "node" && url.length > 0
  return [...url, ...valueEntry(database.connection?.authToken, tokenRequired, host)]
}

/**
 * The variables that the Database Definitions read on the deployed host: the env names of `connection.url` and
 * `connection.authToken`, such as `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, or the D1 HTTP credentials. A D1 or
 * Hyperdrive binding on Cloudflare and a literal value read none.
 */
export function databaseDeploymentEnv(config: ResolvedDBViteConfig | undefined, context: DeploymentEnvContext): DeploymentEnvEntry[] {
  if (!config) return []
  return Object.values(config.databases).flatMap(database => databaseEntries(database, context.host))
}
