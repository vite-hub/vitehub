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

  const consoleRouteName = ["vitehub-console-invocation", "vitehub-console-agents", "vitehub-console-agent", "vitehub-console-kv", "vitehub-console"].find(
    (routeName) => currentRouteName.startsWith(routeName),
  )

  return `${targetRouteName}${consoleRouteName ? currentRouteName.slice(consoleRouteName.length) : ""}`
}
