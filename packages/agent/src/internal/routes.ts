export const defaultAgentChatRoute = "/api/_vitehub/agents/[agent]/chat"
export const defaultAgentDiscordGatewayRoute = "/api/_vitehub/agents/[agent]/discord/gateway"
export const defaultAgentWebhookRoute = "/api/_vitehub/agents/[agent]/webhooks/[webhook]"

export function normalizeAgentRoute(route: string): string {
  const normalized = route.startsWith("/") ? route : `/${route}`
  return normalized.replace(/\[([^\]]+)\]/g, ":$1")
}

export function resolveAgentRoutePath(route: string, values: Record<string, string>): string {
  return normalizeAgentRoute(route).replace(/(^|\/):([^/]+)/g, (match, prefix: string, param: string) => {
    if (!(param in values)) return match
    return `${prefix}${encodeURIComponent(values[param]!)}`
  })
}

export function agentRouteUsesParam(route: false | string | undefined, param: string): boolean {
  return Boolean(route && normalizeAgentRoute(route).split("/").includes(`:${param}`))
}
