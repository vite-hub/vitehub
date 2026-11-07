import { getHostingProvider } from "@vite-hub/internal/hosting"

import { readDatabaseDefinitionConnectionIsStatic } from "../config.ts"

import type { DatabaseConfigValue, ResolvedDBViteConfig } from "../types.ts"

/** The shape of `BundleStartupRule` in `@vite-hub/bundle`. The Database does not depend on that package. */
export interface DatabaseBundleStartupRule {
  owner: string
  packages: string[]
  why: string
  fix: string
}

/** The packages of the libSQL client. Other packages that it imports, such as `js-base64`, can serve other code. */
const libsqlPackages = ["@libsql/client", "@libsql/core", "@libsql/hrana-client", "@libsql/isomorphic-fetch", "@libsql/isomorphic-ws", "libsql"]

/** A URL that can reach a libSQL server from a Worker. A value from the environment can be any URL. */
function canBeRemoteUrl(value: DatabaseConfigValue | undefined): boolean {
  if (value === undefined) return false
  return typeof value !== "string" || !/^(?:file:|:memory:)/i.test(value)
}

/**
 * On Cloudflare, libSQL can only reach a remote URL: a Worker has no files. When every Database is D1 or Postgres and
 * no Database can get a remote URL, libSQL only serves the local SQLite that stands in for D1 in `vite dev`. Then the
 * libSQL client must not load when the Worker starts.
 */
export function libsqlStartupRule(config: ResolvedDBViteConfig | undefined, preset: string | undefined): DatabaseBundleStartupRule | undefined {
  if (!config?.databaseNames.length || getHostingProvider(preset) !== "cloudflare") return
  for (const name of config.databaseNames) {
    const database = config.databases[name]
    if (!database) return
    if (database.dialect === "postgresql") continue
    if (canBeRemoteUrl(database.connection?.url)) return
    const definition = config.definitions.find(item => item.name === name)
    if (definition && !readDatabaseDefinitionConnectionIsStatic(definition.handler)) return
  }
  return {
    owner: "@vite-hub/database",
    packages: libsqlPackages,
    why: "This Worker uses D1 or Postgres for every Database, and no Database sets a remote libSQL URL. libSQL only serves the local SQLite that stands in for D1 in `vite dev`.",
    fix: "If the chain passes through `@vite-hub/database`, update `vite-hub`: the Database then loads libSQL on its first query. If it passes through app code, remove the libSQL import or move it into an `import()` in the code that uses it.",
  }
}
