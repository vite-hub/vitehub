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
