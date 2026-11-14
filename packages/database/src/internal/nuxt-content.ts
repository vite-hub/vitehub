import { renderConfigValueExpression } from "../config-value.ts"

import type { DatabaseConfigValue, ResolvedDBViteConfig } from "../types.ts"

/** Content's `PostgreSQLDatabaseConfig` and `LibSQLDatabaseConfig` from `@nuxt/content`, which this package does not depend on. */
export type NuxtContentDatabaseConfig =
  | { type: "postgresql", url: string }
  | { type: "libsql", authToken?: string, url: string }

export interface NuxtContentDatabase {
  database: NuxtContentDatabaseConfig
  /** Values that the server reads from the environment when it starts. The build holds only an empty string for them. */
  runtimeValues: Partial<Record<"authToken" | "url", DatabaseConfigValue>>
}

/**
 * Maps the default Database to a Nuxt Content `database` config, as Content's NuxtHub preset does for `hub.db`.
 * It returns nothing for local SQLite, D1, and PGlite: Content then keeps its own SQLite file or D1 binding.
 */
export function resolveNuxtContentDatabase(runtime: ResolvedDBViteConfig | undefined): NuxtContentDatabase | undefined {
  const database = runtime?.databases.default
  if (!database) return
  const url = database.connection?.url
  if (url === undefined) return
  if (database.dialect === "postgresql") {
    if (database.driver === "pglite") return
    return withRuntimeValues({ type: "postgresql", url: "" }, { url })
  }
  if (database.cloudflare) return
  // A static local file stays the app's own SQLite file. Content keeps its separate default file.
  if (typeof url === "string" && !/^(?:libsql|https?|wss?):/i.test(url)) return
  const authToken = database.connection?.authToken
  return withRuntimeValues({ type: "libsql", url: "" }, authToken === undefined ? { url } : { authToken, url })
}

function withRuntimeValues(database: NuxtContentDatabaseConfig, values: NuxtContentDatabase["runtimeValues"]): NuxtContentDatabase {
  const runtimeValues: NuxtContentDatabase["runtimeValues"] = {}
  for (const key of ["url", "authToken"] as const) {
    const value = values[key]
    if (value === undefined) continue
    if (typeof value === "string") Object.assign(database, { [key]: value })
    else {
      Object.assign(database, { [key]: "" })
      runtimeValues[key] = value
    }
  }
  return { database, runtimeValues }
}

/** A Nitro plugin that fills the empty Content database values from the environment before the first query. */
export function renderNuxtContentDatabasePlugin(runtimeValues: NuxtContentDatabase["runtimeValues"]) {
  const assignments = Object.entries(runtimeValues).flatMap(([key, value]) => {
    const expression = renderConfigValueExpression(value)
    return expression ? [`  database.${key} ||= ${expression}`] : []
  })
  if (!assignments.length) return
  return [
    "import { useRuntimeConfig } from \"nitro/runtime-config\"",
    "",
    "// Content reads `runtimeConfig.content.database` on its first query. NUXT_CONTENT_DATABASE_* variables still win.",
    "export default () => {",
    "  const database = useRuntimeConfig().content?.database",
    "  if (!database) return",
    ...assignments,
    "}",
    "",
  ].join("\n")
}
