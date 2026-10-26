import type { ServerEnvDescriptionEntry } from "@vite-hub/env"

/** A Server Env declaration as the Env page lists it: the name inside its group, with the parent path kept apart. */
export interface ConsoleEnvRow {
  readonly entry: ServerEnvDescriptionEntry
  /** The last path segment, such as `textColor`. Empty when the declaration does not disclose its name. */
  readonly name: string
  /** The segments between the group and the name, such as `labels.GitHub.color.`. */
  readonly parent: string
}

/** Declarations that share the first path segment after `env.server`, such as every `executor.*` value. */
export interface ConsoleEnvGroup {
  /**
   * The shared segment, `""` for the other values, or `undefined` for declarations without a disclosed name. The other
   * values are top-level values and namespaces with one value, such as `github.token`.
   */
  readonly name: string | undefined
  readonly rows: readonly ConsoleEnvRow[]
}

/** The path without the `env.server.` prefix that every Server Env declaration shares. */
export function consoleEnvName(entry: ServerEnvDescriptionEntry): string | undefined {
  return entry.path?.replace(/^env\.server\./, "")
}

/**
 * Groups declarations by their first path segment, in declaration order. A namespace with one value joins the other
 * values with its full name, so a group heading never labels a single row. The other values come after the namespaces
 * and undisclosed names come last.
 */
export function groupConsoleEnv(entries: readonly ServerEnvDescriptionEntry[]): ConsoleEnvGroup[] {
  const namespaces = new Map<string | undefined, ServerEnvDescriptionEntry[]>()
  for (const entry of entries) {
    const segments = consoleEnvName(entry)?.split(".")
    const namespace = !segments ? undefined : segments.length > 1 ? segments[0] : ""
    namespaces.set(namespace, [...(namespaces.get(namespace) ?? []), entry])
  }
  const groups = new Map<string | undefined, ConsoleEnvRow[]>()
  for (const [namespace, members] of namespaces) {
    const group = namespace && members.length === 1 ? "" : namespace
    for (const entry of members) {
      const segments = consoleEnvName(entry)?.split(".") ?? []
      const parent = segments.slice(group ? 1 : 0, -1).join(".")
      groups.set(group, [...(groups.get(group) ?? []), { entry, name: segments.at(-1) ?? "", parent: parent && `${parent}.` }])
    }
  }
  const order = new Map(entries.map((entry, index) => [entry, index]))
  const rank = (name: string | undefined) => (name === "" ? 1 : name === undefined ? 2 : 0)
  return [...groups]
    .map(([name, rows]) => ({ name, rows: rows.toSorted((a, b) => (order.get(a.entry) ?? 0) - (order.get(b.entry) ?? 0)) }))
    .sort((a, b) => rank(a.name) - rank(b.name))
}
