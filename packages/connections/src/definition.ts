import { connectionError } from "./errors.ts"
import { assertConnectionOrigins } from "./origins.ts"

import type { ConnectionAccessRule, ConnectionDefinition, ConnectionProvider } from "./types.ts"

function assertPatterns(value: unknown, path: string): void {
  if (value === undefined) return
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Connection Definitions can come from JavaScript files, so the shape is checked at runtime.
  if (!Array.isArray(value) || value.some(pattern => typeof pattern !== "string" || !pattern.trim())) {
    throw connectionError("invalid", { path })
  }
}

function assertRule(rule: ConnectionAccessRule | undefined, path: string): void {
  if (rule === undefined) return
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Connection Definitions can come from JavaScript files, so the shape is checked at runtime.
  if (!rule || typeof rule !== "object") throw connectionError("invalid", { path })
  assertPatterns(rule.allow, `${path}.allow`)
  assertPatterns(rule.approve, `${path}.approve`)
  assertPatterns(rule.deny, `${path}.deny`)
}

/** Declares a Connection in `server/connections/<name>.ts`. The file name is the Connection name. */
export function defineConnection<TProvider extends ConnectionProvider>(
  definition: ConnectionDefinition<TProvider>,
): ConnectionDefinition<TProvider> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Connection Definitions can come from JavaScript files, so the shape is checked at runtime.
  if (!definition || typeof definition !== "object" || !definition.provider || definition.provider.kind !== "oauth2") {
    throw connectionError("invalid", { path: "provider" })
  }
  assertConnectionOrigins(definition.provider.origins)
  assertRule(definition.access?.server, "access.server")
  for (const [name, rule] of Object.entries(definition.access?.routes ?? {})) assertRule(rule, `access.routes.${name}`)
  for (const [name, rule] of Object.entries(definition.access?.agents ?? {})) assertRule(rule, `access.agents.${name}`)
  return definition
}
