import { hostedConsoleOrigin } from "./hosted-console.ts"
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

/**
 * Resolve the public origin of this deployment.
 *
 * A configured origin always wins over the request: the single `vitehub({ publicUrl })` origin, then the origin of
 * the Agent, then, for a request, the configured origin with the same host as the request or the only configured origin. When
 * `publicUrl` configures several origins and none of them fits, the result is `undefined`: the request Host cannot
 * name a new origin. Only when nothing is configured, such as in `vite dev`, the request origin is the result.
 * Set `configuredOnly` when the request must not supply it in that case either.
 */
export function resolvePublicUrl(options: { agentName?: string, request?: Pick<Request, "url">, configuredOnly?: boolean } = {}): string | undefined {
  const config = publicUrlConfig()
  if (config.url) return config.url
  const discoveredName = options.agentName ? publicUrlAgentNames.get(options.agentName) : undefined
  const agentUrl = options.agentName
    ? configuredAgentUrl(config, options.agentName) ?? (discoveredName ? configuredAgentUrl(config, discoveredName) : undefined)
    : undefined
  if (agentUrl || !options.request) return agentUrl
  const request = new URL(options.request.url)
  const configured = [...new Set(Object.values(config.agents ?? {}))]
  if (configured.length) return configured.find(url => new URL(url).host === request.host) ?? (configured.length === 1 ? configured[0] : undefined)
  return options.configuredOnly ? undefined : request.origin
}

/**
 * Build the hosted Console URL that opens one Agent invocation, such as
 * `https://console.vitehub.dev/open?project=https%3A%2F%2Fapp.example.com&path=%2Fagents%2Fbot%2Finvocations%2Fid`.
 * `origin` must not include the application base path. The hosted Console checks the project URL when it opens the link.
 */
export function consoleInvocationUrl(origin: string, agentName: string, invocationId: string): string {
  const project = `${new URL(origin).origin}${applicationBasePath()}`
  const path = `/agents/${encodeRouteSegment(agentName)}/invocations/${encodeURIComponent(invocationId)}`
  // Vercel's Workflow VM has `URL` but no `URLSearchParams`, so the query is built by hand.
  return `${hostedConsoleOrigin}/open?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`
}
