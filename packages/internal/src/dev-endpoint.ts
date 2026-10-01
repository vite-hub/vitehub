import { isIP } from "node:net"

import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Guard that a dev endpoint requires on each request.
 *
 * `label` names the endpoint in rejection messages, for example
 * `Forbidden Workspace Dev request.`.
 */
export interface ViteHubDevEndpointGuard {
  header: string
  headerValue: string
  label: string
}

/**
 * Parts of a Vite development server that dev endpoints use.
 */
export interface ViteHubDevEndpointServer {
  config: {
    server: {
      /** Host names that Vite accepts in the `Host` header. `true` accepts all hosts. */
      allowedHosts?: readonly string[] | true
      /** Host that the dev server listens on. A string host is also an allowed host. */
      host?: string | boolean
      /** When set, Vite does not check the `Host` header, because TLS binds the host name. */
      hmr?: boolean | { host?: string }
      origin?: string
      https?: unknown
      port?: number
    }
  }
  middlewares: {
    use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => unknown
  }
  resolvedUrls?: { local?: readonly string[] } | null
}

export interface ViteHubDevEndpointOptions extends ViteHubDevEndpointGuard {
  /**
   * Handles a request that passed the route, method, and guard checks.
   * The handler writes the response.
   */
  handle: (req: IncomingMessage, res: ServerResponse) => void
  /**
   * Methods that the endpoint accepts. Other methods get `405` before the guard runs.
   * When omitted, the handler checks the method.
   */
  methods?: readonly string[]
  route: string
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function hostHeaderAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const trimmed = host.trim().toLowerCase()
  // Vite accepts these protocol-like Host values before parsing a hostname.
  // Keep the endpoint guard aligned so browser and extension clients are not blocked.
  if (/^(?:file|.+-extension):/i.test(trimmed)) return true
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]")
    return end > 0 && isIP(trimmed.slice(1, end)) === 6
  }
  const colon = trimmed.indexOf(":")
  const hostname = colon === -1 ? trimmed : trimmed.slice(0, colon)
  if (isIP(hostname) === 4) return true
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true
  return allowedHosts.some(value => {
    const allowed = value.toLowerCase()
    return allowed === hostname
      || (allowed.startsWith(".") && (allowed.slice(1) === hostname || hostname.endsWith(allowed)))
  })
}

/**
 * Checks the `Host` header with the same rules as Vite's host validation.
 *
 * Accepts a missing header, IP literals, `localhost`, `*.localhost`, the configured
 * `server.host`, `server.hmr.host`, `server.origin`, and `server.allowedHosts`. An entry that starts with `.` also accepts
 * its subdomains. Vite includes the comma-separated environment host list in resolved `server.allowedHosts`.
 * `allowedHosts: true` or `server.https` accepts all hosts, as in Vite.
 *
 * Dev endpoints run this check themselves, so they do not depend on the host
 * framework to run Vite's host validation before them. This blocks DNS rebinding:
 * a page on a rebound host name sends a matching `Origin`, but its `Host` is not allowed.
 */
export function isViteHubDevHostAllowed(server: Pick<ViteHubDevEndpointServer, "config">, req: IncomingMessage): boolean {
  const host = firstHeader(req.headers.host)
  if (host === undefined) return true
  const { allowedHosts = [], host: listenHost, hmr, origin, https } = server.config.server
  if (allowedHosts === true || https) return true
  const additionalHosts = [...allowedHosts]
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vite allows a string hostname or a boolean listen-host setting.
  if (typeof listenHost === "string") additionalHosts.push(listenHost)
  if (hmr && hmr !== true && hmr.host) additionalHosts.push(hmr.host)
  if (origin) {
    try {
      additionalHosts.push(new URL(origin).hostname)
    }
    catch {
      // Invalid origins do not add a host allowance.
    }
  }
  return hostHeaderAllowed(host, additionalHosts)
}

/**
 * Origin that the dev server serves the request on. Browser requests from other origins are rejected.
 */
export function viteHubDevRequestOrigin(server: Pick<ViteHubDevEndpointServer, "config" | "resolvedUrls">, req: IncomingMessage): string {
  const host = firstHeader(req.headers.host)
  if (host) {
    const fallback = server.resolvedUrls?.local?.[0] || "http://localhost/"
    return new URL(`${new URL(fallback).protocol}//${host}`).origin
  }
  const base = server.resolvedUrls?.local?.[0] || `http://localhost:${server.config.server.port || 5173}/`
  return new URL(base).origin
}

/**
 * Checks the `Host` header, the guard header, the request origin, and the JSON content
 * type of `POST` requests. Returns the rejection response, or `undefined` when the
 * request can continue.
 */
export function validateViteHubDevRequest(
  server: Pick<ViteHubDevEndpointServer, "config" | "resolvedUrls">,
  req: IncomingMessage,
  guard: ViteHubDevEndpointGuard,
): Response | undefined {
  if (!isViteHubDevHostAllowed(server, req)) {
    return new Response(`Forbidden ${guard.label} host.`, { status: 403 })
  }
  if (firstHeader(req.headers[guard.header]) !== guard.headerValue) {
    return new Response(`Forbidden ${guard.label} request.`, { status: 403 })
  }
  const origin = firstHeader(req.headers.origin)
  if (origin && origin !== viteHubDevRequestOrigin(server, req)) {
    return new Response(`Forbidden ${guard.label} origin.`, { status: 403 })
  }
  if (req.method !== "POST") return
  const contentType = firstHeader(req.headers["content-type"])
  if (!contentType?.toLowerCase().startsWith("application/json")) {
    return new Response(`${guard.label} requests must use application/json.`, { status: 415 })
  }
}

export function isViteHubDevRoute(req: IncomingMessage, route: string): boolean {
  return new URL(req.url || "/", "http://localhost").pathname === route
}

async function writeRejection(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  for (const [name, value] of response.headers) res.setHeader(name, value)
  const body = await response.arrayBuffer()
  if (body.byteLength) res.write(Buffer.from(body))
  res.end()
}

/**
 * Registers a guarded dev endpoint on a Vite development server.
 *
 * The middleware skips other routes, rejects methods outside `methods`, and
 * runs {@link validateViteHubDevRequest} before it calls `handle`. Dev
 * endpoints exist only on the development server. They are not an
 * authenticated path to a deployed stage.
 */
export function registerViteHubDevEndpoint(server: ViteHubDevEndpointServer, options: ViteHubDevEndpointOptions): void {
  server.middlewares.use((req, res, next) => {
    if (!isViteHubDevRoute(req, options.route)) {
      next()
      return
    }
    if (options.methods && !options.methods.includes(req.method || "")) {
      void writeRejection(res, new Response("Method not allowed.", { status: 405 }))
      return
    }
    const blocked = validateViteHubDevRequest(server, req, options)
    if (blocked) {
      void writeRejection(res, blocked)
      return
    }
    options.handle(req, res)
  })
}
