export function encodeAgentRouteParam(name: string): string {
  return `~${name}`
}

export function decodeAgentRouteParam(
  value: string | string[] | undefined,
): string | undefined {
  const segment = Array.isArray(value) ? value[0] : value
  return segment?.startsWith("~") && segment.length > 1
    ? segment.slice(1)
    : undefined
}

export function resolveAgentRouteName(
  currentRouteName: string | symbol | null | undefined,
  targetRouteName: string,
): string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vue Router defines route names as strings or symbols; only host-decorated string names can carry a suffix.
  const localeSuffix = typeof currentRouteName === "string"
    ? currentRouteName.match(/___[^/]+$/)?.[0]
    : undefined
  return `${targetRouteName}${localeSuffix ?? ""}`
}
