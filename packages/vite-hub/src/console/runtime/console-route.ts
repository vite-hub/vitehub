export const consoleDatabaseSchemaPath = "/database/schema/diagram"
export const consoleDatabaseTablePath = "/database/:table?"
export const consoleDatabasesSchemaPath = "/databases/:database/schema"
export const consoleDatabasesTablePath = "/databases/:database?/:table?"

export function encodeAgentRouteParam(name: string): string {
  return `~${name}`
}

export function decodeAgentRouteParam(value: string | string[] | undefined): string | undefined {
  const segment = Array.isArray(value) ? value[0] : value
  return segment?.startsWith("~") && segment.length > 1 ? segment.slice(1) : undefined
}

export function resolveConsoleRouteName(currentRouteName: string | symbol | null | undefined, targetRouteName: string): string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vue Router defines route names as strings or symbols; only host-decorated string names can carry a suffix.
  if (typeof currentRouteName !== "string") return targetRouteName

  const consoleRouteName = [
    "vitehub-console-databases-schema",
    "vitehub-console-database-schema",
    "vitehub-console-invocation",
    "vitehub-console-rate-limits",
    "vitehub-console-workspaces",
    "vitehub-console-workflows",
    "vitehub-console-sandboxes",
    "vitehub-console-schedules",
    "vitehub-console-databases",
    "vitehub-console-database",
    "vitehub-console-queues",
    "vitehub-console-agents",
    "vitehub-console-agent",
    "vitehub-console-usage",
    "vitehub-console-blob",
    "vitehub-console-kv",
    "vitehub-console",
  ].find(
    (routeName) => currentRouteName.startsWith(routeName),
  )

  return `${targetRouteName}${consoleRouteName ? currentRouteName.slice(consoleRouteName.length) : ""}`
}
