import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"

/** The resolved `vitehub({ redirects })` options that the generated code passes. */
export interface RedirectsPolicy {
  /** The canonical host name, in lower case. */
  host?: string
  https?: boolean
  trailingSlash?: "add" | "remove"
  /** Host names that keep their host and scheme. `*.` matches every subdomain. */
  previewHosts: string[]
}

interface NitroAppLike {
  fetch?: unknown
}

interface WorkerHandler {
  fetch(request: Request, env: { ASSETS?: { fetch(request: Request): Promise<Response> } }, context: unknown): Promise<Response>
}

const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * Tells if a request to `hostname` keeps its host and scheme: a local name (`localhost`, `*.localhost`, a name without a
 * dot such as a container name), an IP address (load balancer health checks use it), or a preview host.
 */
function keepsOrigin(hostname: string, previewHosts: readonly string[]): boolean {
  if (!hostname.includes(".") || hostname.endsWith(".localhost") || hostname.startsWith("[") || ipv4.test(hostname)) return true
  return previewHosts.some(pattern => pattern.startsWith("*.") ? hostname.endsWith(pattern.slice(1)) : hostname === pattern)
}

/**
 * Tells if the trailing-slash rule applies: a page request, which is `GET` or `HEAD`, is not under `/api/` or a
 * framework path that starts with `/_`, and has no file extension. API clients and webhooks do not always follow a
 * redirect, so their paths stay as they are.
 */
function isPagePath(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false
  if (pathname === "/" || pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/_")) return false
  return !pathname.replace(/\/+$/, "").split("/").pop()!.includes(".")
}

/**
 * The redirect to the canonical address of `request`, or `undefined` when the request is already there. The origin
 * honours `X-Forwarded-Proto` and `X-Forwarded-Host`, so a server behind a proxy that ends TLS does not redirect in a
 * loop. A client that sends these headers itself only skips its own redirect. One redirect fixes the scheme, the
 * host, and the trailing slash together. `GET` and `HEAD` get 301, other methods get 308, which keeps the method and
 * the body.
 */
export function canonicalRedirect(request: Pick<Request, "headers" | "method" | "url">, policy: RedirectsPolicy): Response | undefined {
  const url = new URL(request.url)
  const origin = new URL(forwardedRequestOrigin(request))
  let protocol = origin.protocol
  let host = origin.host
  if (!keepsOrigin(origin.hostname, policy.previewHosts)) {
    if (policy.https && protocol !== "https:") {
      protocol = "https:"
      host = origin.hostname
    }
    if (policy.host && origin.hostname !== policy.host) host = policy.host
  }
  let pathname = url.pathname
  if (policy.trailingSlash && isPagePath(request.method, pathname)) {
    pathname = policy.trailingSlash === "remove" ? pathname.replace(/\/+$/, "") : pathname.endsWith("/") ? pathname : `${pathname}/`
  }
  if (protocol === origin.protocol && host === origin.host && pathname === url.pathname) return
  // Always an absolute URL: a relative `//example.com` path would leave the site.
  return new Response(null, {
    status: request.method === "GET" || request.method === "HEAD" ? 301 : 308,
    headers: { location: `${protocol}//${host}${pathname}${url.search}` },
  })
}

/** Installs `vitehub({ redirects })` on a Nitro app: it wraps `nitroApp.fetch`, the entry of every preset. */
export function installRedirects(nitroApp: NitroAppLike, policy: RedirectsPolicy): void {
  const fetch = nitroApp.fetch
  if (!(fetch instanceof Function)) return
  nitroApp.fetch = (request: Request, ...rest: unknown[]) => canonicalRedirect(request, policy) ?? Reflect.apply(fetch, nitroApp, [request, ...rest])
}

/**
 * Wraps a Cloudflare Worker handler whose static files run the Worker first (`assets.run_worker_first`). It sends the
 * redirect before any file is served, then does what Cloudflare does without `run_worker_first`: a `GET` or `HEAD`
 * gets the static file when one matches, and the app answers the rest.
 */
export function withCloudflareRedirects<Handler extends WorkerHandler>(handler: Handler, policy: RedirectsPolicy): Handler & WorkerHandler {
  return {
    ...handler,
    async fetch(request, env, context) {
      const redirect = canonicalRedirect(request, policy)
      if (redirect) return redirect
      if (env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
        const asset = await env.ASSETS.fetch(request)
        if (asset.status !== 404) return asset
      }
      return handler.fetch(request, env, context)
    },
  }
}
