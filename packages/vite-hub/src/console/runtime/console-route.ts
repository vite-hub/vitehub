import { viteHubErrorDiagnostics } from "../../error-diagnostics.ts"
import { decodeRouteSegment, encodeRouteSegment } from "@vite-hub/runtime"
export const consoleDatabasesSchemaPath = "/databases/:database/schema/diagram"
export const consoleDatabasesTablePath = "/databases/:database?/:table?"

/** Return the application mount prefix before the Console route marker. */
export function consoleMountBase(pathname: string): string {
  const marker = "/_vitehub"
  let markerIndex = pathname.lastIndexOf(marker)
  while (markerIndex > 0 && pathname.length > markerIndex + marker.length && pathname[markerIndex + marker.length] !== "/") {
    markerIndex = pathname.lastIndexOf(marker, markerIndex - 1)
  }
  return markerIndex > 0
    ? pathname.slice(0, markerIndex).replace(/\/+$/, "")
    : ""
}

/** Prefix an internal Console route with an application mount path. */
export function consoleMountPath(base: string, path: string): string {
  return `${base}${path}`
}

/** Matches a built-in or contributed Console route name. A host suffix such as `___en` stays outside the match. */
const consoleRouteNamePattern = /^vitehub-console(?:-[a-z0-9]+)*/

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

/** Prefer the Usage filter when opening sessions, then return to the originating Agent. */
export function resolveUsageSessionsAgent(
  query: { agent?: string | null | (string | null)[]; returnAgent?: string | null | (string | null)[] },
  selectedAgent?: string,
): string | undefined {
  for (const value of [query.agent, selectedAgent, query.returnAgent]) {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Query values can also be arrays or null.
    if (typeof value !== "string") continue
    const name = value.trim()
    if (name && name.length <= 512) return name
  }
}

export function resolveConsoleRouteName(currentRouteName: string | symbol | null | undefined, targetRouteName: string): string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vue Router defines route names as strings or symbols; only host-decorated string names can carry a suffix.
  if (typeof currentRouteName !== "string") return targetRouteName

  const consoleRouteName = consoleRouteNamePattern.exec(currentRouteName)?.[0]

  return `${targetRouteName}${consoleRouteName ? currentRouteName.slice(consoleRouteName.length) : ""}`
}
