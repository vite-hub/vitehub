export const consoleDatabaseSchemaPath = "/database/schema/diagram"
export const consoleDatabaseTablePath = "/database/:table?"
export const consoleDatabasesSchemaPath = "/databases/:database/schema/diagram"
export const consoleDatabasesTablePath = "/databases/:database?/:table?"

const agentRouteParamPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function encodeAgentRouteParam(name: string): string {
  if (!agentRouteParamPattern.test(name)) {
    throw new TypeError(`[vitehub] Agent name ${JSON.stringify(name)} must use lowercase letters, numbers, and single hyphens.`)
  }
  return name
}

export function decodeAgentRouteParam(value: string | string[] | undefined): string | undefined {
  const segment = Array.isArray(value) ? value[0] : value
  return segment && agentRouteParamPattern.test(segment) ? segment : undefined
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
