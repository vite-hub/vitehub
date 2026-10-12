import { agentDiagnostics } from "../agent-diagnostics.ts"

export const defaultAgentChatRoute = "/api/_vitehub/agents/[agent]/chat"
export const agentChatInvocationIdHeader = "x-vitehub-invocation-id"
export const defaultAgentDiscordGatewayRoute = "/api/_vitehub/agents/[agent]/discord/gateway"
export const defaultAgentInspectionRoute = "/api/_vitehub/agents/[agent]/inspection"
export const defaultAgentWebhookRoute = "/api/_vitehub/agents/[agent]/webhooks/[webhook]"

export function normalizeAgentRoute(route: string): string {
  const normalized = route.startsWith("/") ? route : `/${route}`
  return normalized.replace(/\[([^\]]+)\]/g, ":$1")
}

export function resolveAgentRoutePath(route: string, values: Record<string, string>): string {
  return normalizeAgentRoute(route).replace(/(^|\/):([^/]+)/g, (match, prefix: string, param: string) => {
    if (!Object.hasOwn(values, param)) return match
    return `${prefix}${encodeURIComponent(values[param]!)}`
  })
}

export function agentRouteUsesParam(route: false | string | undefined, param: string): boolean {
  return Boolean(route && normalizeAgentRoute(route).split("/").includes(`:${param}`))
}

/**
 * Generated static endpoints must not shadow application handlers.
 * With `namespace`, the route lives in a path that ViteHub reserves, such as `/_vitehub/agent`.
 * A catch-all above that path, such as the Console page at `/_vitehub/**` or an application fallback at `/**`,
 * is a fallback: the router matches the static route first, and the catch-all never owns the reserved path.
 */
export function validateAgentStaticRoute(route: string, handlers: readonly { route: string, middleware?: boolean }[], label = "readiness", namespace?: string): string {
  const normalized = normalizeAgentRoute(route).replace(/\/$/, "") || "/"
  if (!route.trim() || /[:*?#\x5B\x5D]/.test(normalized)) {
    throw agentDiagnostics.AGENT_B0006({ message: `[vitehub] Agent ${label} requires a static route path.` })
  }
  const target = normalized.split("/")
  const namespaceDepth = namespace && normalized.startsWith(`${normalizeAgentRoute(namespace).replace(/\/$/, "")}/`) ? normalizeAgentRoute(namespace).replace(/\/$/, "").split("/").length : 0
  const conflict = handlers.find(({ route: handler, middleware }) => {
    if (middleware) return false
    const parts = (normalizeAgentRoute(handler).replace(/\/$/, "") || "/").split("/")
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!
      if (part.startsWith("**") || part.startsWith(":...")) return part !== "**" || index >= namespaceDepth || parts.slice(0, index).some(prefix => prefix.startsWith(":") || prefix.includes("*"))
      if (target[index] === undefined) return false
      if (part !== target[index] && !part.startsWith(":") && part !== "*") return false
    }
    return parts.length === target.length
  })
  if (conflict) throw agentDiagnostics.AGENT_B0006({ message: `[vitehub] Agent ${label} route conflicts with the existing route ${JSON.stringify(conflict.route)}.` })
  return normalized
}
