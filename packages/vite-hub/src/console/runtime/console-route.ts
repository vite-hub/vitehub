import { viteHubErrorDiagnostics } from "../../error-diagnostics.ts"
import { decodeRouteSegment, encodeRouteSegment } from "@vite-hub/runtime"
export const consoleDatabaseSchemaPath = "/database/schema/diagram"
export const consoleDatabaseTablePath = "/database/:table?"
export const consoleDatabasesSchemaPath = "/databases/:database/schema/diagram"
export const consoleDatabasesTablePath = "/databases/:database?/:table?"

export function encodeAgentRouteParam(name: string): string {
  if (!name || name.trim() !== name || name.length > 512) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0045({ message: `[vitehub] Agent name ${JSON.stringify(name)} must be a non-empty trimmed string of at most 512 characters.` })
  }
  return encodeRouteSegment(name)
}

export function decodeAgentRouteParam(value: string | string[] | undefined): string | undefined {
  const segment = Array.isArray(value) ? value[0] : value
  const name = segment ? decodeRouteSegment(segment) : undefined
  return name && name.trim() === name && name.length <= 512 ? name : undefined
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
    "vitehub-console-env",
    "vitehub-console",
  ].find(
    (routeName) => currentRouteName.startsWith(routeName),
  )

  return `${targetRouteName}${consoleRouteName ? currentRouteName.slice(consoleRouteName.length) : ""}`
}
