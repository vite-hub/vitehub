/** How `resolveDefaultDatabase()` picked a Database, or why it could not. */
export type DefaultDatabaseResolution =
  | { status: "resolved", name: string, reason: "default" | "only" }
  | { status: "ambiguous", names: string[] }
  | { status: "none" }

/**
 * Resolves "the default or only Database": the Definition named `default`, else the only Definition. Several
 * Definitions without a `default` are ambiguous; no Definitions resolve to `none`.
 */
export function resolveDefaultDatabase(databaseNames: readonly string[]): DefaultDatabaseResolution {
  if (databaseNames.includes("default")) return { name: "default", reason: "default", status: "resolved" }
  if (databaseNames.length === 1) return { name: databaseNames[0]!, reason: "only", status: "resolved" }
  if (databaseNames.length) return { names: [...databaseNames].sort(), status: "ambiguous" }
  return { status: "none" }
}
