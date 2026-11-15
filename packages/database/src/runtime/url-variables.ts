import { formatRuntimeDiagnosticError } from "@vite-hub/runtime"

import { postgresSchemes } from "../database-location.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { defaultUrl } from "./definition-config.ts"

import type { RuntimeDrizzleDatabaseConfig } from "../types.ts"

/** The libSQL variables that NuxtHub and `connectDatabase()` read without config, in NuxtHub's order, with their tokens. */
const urlVariables: ReadonlyArray<readonly [variable: string, token?: string]> = [
  ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"],
  ["LIBSQL_URL", "LIBSQL_AUTH_TOKEN"],
  ["DATABASE_URL"],
]

const warned = new Set<string>()

/**
 * A Database Definition connects only where `connection` says. When it has none and a libSQL URL variable is set, the
 * app most likely expects that database, so say once per database that the data goes to the local file.
 */
export function warnIgnoredUrlVariable(config: RuntimeDrizzleDatabaseConfig) {
  if (config.cloudflare || warned.has(config.name) || config.connection?.url !== defaultUrl(config.name)) return
  const env = globalThis.process?.env
  const found = urlVariables.find(([variable]) => {
    const value = env?.[variable]?.trim()
    return value && !postgresSchemes.test(value)
  })
  if (!found) return
  warned.add(config.name)
  const [variable, token] = found
  const file = defaultUrl(config.name).slice("file:".length)
  console.warn(formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_URL_VARIABLE_IGNORED({ database: config.name, file, token, variable })))
}
