import { encodeRouteSegment } from "./route-segment.ts"

/** Public origins resolved from `vitehub({ publicUrl })` at build time. */
export interface PublicUrlConfig {
  /** One origin for the whole deployment. */
  url?: string
  /** One origin per discovered Agent, from the function form. */
  agents?: Record<string, string>
}

declare const __VITEHUB_PUBLIC_URL__: PublicUrlConfig | undefined
declare const __VITEHUB_APP_BASE_URL__: string | undefined

const publicUrlAgentNames = new Map<string, string | null>()

/** Replace aliases when a generated Agent registry is installed. */
export function resetPublicUrlAgentNames(): void {
  publicUrlAgentNames.clear()
}

/** Associate an evaluated Agent name with the identity used by build-time URL configuration. */
export function registerPublicUrlAgentName(name: string, discoveredName: string): void {
  const previous = publicUrlAgentNames.get(name)
  publicUrlAgentNames.set(name, previous === undefined || previous === discoveredName ? discoveredName : null)
}

function publicUrlConfig(): PublicUrlConfig {
  return typeof __VITEHUB_PUBLIC_URL__ === "undefined" ? {} : __VITEHUB_PUBLIC_URL__
}

function applicationBasePath(): string {
  const configured = typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_APP_BASE_URL__
  const segments = configured.split("/").filter(Boolean)
  return segments.length ? `/${segments.join("/")}` : ""
}

function configuredAgentUrl(config: PublicUrlConfig, name: string): string | undefined {
  return config.agents && Object.hasOwn(config.agents, name) ? config.agents[name] : undefined
}

function isInternalRequestHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === "internal") return true
  if (host.endsWith(".internal") || host.endsWith(".svc")) return true
  const octets = host.split(".").map(Number)
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168)
}

/**
 * Resolve the public origin of this deployment.
 *
 * Order: the Agent's origin from `vitehub({ publicUrl })`, the single configured
 * origin, the configured origin with the same host as the request, the configured
 * origin for an internal request host, and then the request origin.
 */
export function resolvePublicUrl(options: { agentName?: string, request: Pick<Request, "url"> }): string
export function resolvePublicUrl(options?: { agentName?: string, request?: Pick<Request, "url"> }): string | undefined
export function resolvePublicUrl(options: { agentName?: string, request?: Pick<Request, "url"> } = {}): string | undefined {
  const config = publicUrlConfig()
  const discoveredName = options.agentName ? publicUrlAgentNames.get(options.agentName) : undefined
  const agentUrl = options.agentName
    ? configuredAgentUrl(config, options.agentName) ?? (discoveredName ? configuredAgentUrl(config, discoveredName) : undefined)
    : undefined
  if (config.url) return config.url
  if (!options.request) return agentUrl
  const request = new URL(options.request.url)
  const configuredAgents = Object.values(config.agents ?? {})
  const requestHostUrl = configuredAgents.find(url => new URL(url).host === request.host)
  if (requestHostUrl) return requestHostUrl
  if (isInternalRequestHost(request.hostname)) return agentUrl ?? (configuredAgents.length === 1 ? configuredAgents[0] : request.origin)
  return request.origin
}

/** Build the Console URL of one Agent invocation. `origin` must not include the application base path. */
export function consoleInvocationUrl(origin: string, agentName: string, invocationId: string): string {
  const path = `${applicationBasePath()}/_vitehub/agents/${encodeRouteSegment(agentName)}/invocations/${encodeURIComponent(invocationId)}`
  return new URL(path, origin).href
}
