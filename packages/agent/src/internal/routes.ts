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
    if (!(param in values)) return match
    return `${prefix}${encodeURIComponent(values[param]!)}`
  })
}

export function agentRouteUsesParam(route: false | string | undefined, param: string): boolean {
  return Boolean(route && normalizeAgentRoute(route).split("/").includes(`:${param}`))
}

/** Readiness is a static endpoint and must not shadow an application handler. */
export function validateAgentPreparationRoute(route: string, handlers: readonly string[]): string {
  const normalized = normalizeAgentRoute(route).replace(/\/$/, "") || "/"
  if (!route.trim() || /[:*?#\[\]]/.test(normalized)) {
    throw agentDiagnostics.AGENT_B0006({ message: "[vitehub] Agent readiness requires a static route path." })
  }
  const target = normalized.split("/")
  const conflict = handlers.find(handler => {
    const parts = (normalizeAgentRoute(handler).replace(/\/$/, "") || "/").split("/")
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!
      if (part.startsWith("**") || part.startsWith(":...")) return true
      if (target[index] === undefined) return false
      if (part !== target[index] && !part.startsWith(":") && part !== "*") return false
    }
    return parts.length === target.length
  })
  if (conflict) throw agentDiagnostics.AGENT_B0006({ message: `[vitehub] Agent readiness route conflicts with the existing route ${JSON.stringify(conflict)}.` })
  return normalized
}
