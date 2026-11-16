import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"

/** The request options of `vitehub({ trustProxy, sameOriginWrites })` that the generated Nitro plugin passes. */
export interface RequestPolicyOptions {
  trustProxy?: boolean
  /** Path prefixes that skip the same-origin check, or `false` for no check. */
  sameOriginWrites?: false | { exclude: string[] }
}

interface RequestEventLike {
  readonly req: { readonly headers: Headers }
  readonly url: URL
}

type RequestHook = (event: RequestEventLike) => void

interface NitroAppLike {
  fetch?: unknown
  hooks?: {
    _hooks?: Record<string, unknown[] | undefined>
    hook(name: "request", handler: RequestHook): unknown
  }
}

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * Behind a proxy that ends TLS, the server sees `http:` requests. When the first `X-Forwarded-Proto` value is `https`,
 * this sets the event URL to `https:`. On Node, the URL of `event.req` is the same object, so code that reads the
 * request, such as Better Auth, sees `https:` too. It never changes the host, and never turns `https:` into `http:`.
 */
export function trustForwardedProto(event: RequestEventLike): void {
  if (event.url.protocol !== "http:") return
  const protocol = event.req.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase()
  if (protocol === "https") event.url.protocol = "https:"
}

function excluded(pathname: string, exclude: readonly string[]): boolean {
  return exclude.some((prefix) => {
    const path = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix
    return pathname === path || pathname.startsWith(`${path}/`)
  })
}

/**
 * Tells if a request is a browser write from another origin that carries cookies: an unsafe method, a `Cookie`
 * header, and `Sec-Fetch-Site` other than `same-origin` or `none`, or an `Origin` other than the request origin. The
 * request origin honours `X-Forwarded-Proto` and `X-Forwarded-Host`, as the other origin checks of ViteHub do.
 * Requests without cookies, such as agents with bearer tokens and webhooks, are never cross-origin writes.
 */
export function isCrossOriginWrite(request: Pick<Request, "headers" | "method" | "url">, exclude: readonly string[] = []): boolean {
  if (safeMethods.has(request.method) || !request.headers.has("cookie")) return false
  const site = request.headers.get("sec-fetch-site")
  const origin = request.headers.get("origin")
  const crossSite = Boolean(site) && site !== "same-origin" && site !== "none"
  if (!crossSite && (!origin || origin === forwardedRequestOrigin(request))) return false
  return !excluded(new URL(request.url).pathname, exclude)
}

function crossOriginWriteResponse(): Response {
  return Response.json({
    error: {
      code: "VITEHUB_CROSS_ORIGIN_WRITE",
      why: "This request carries cookies and comes from another origin. The app takes writes with cookies from its own pages only.",
    },
  }, { status: 403, headers: { "cache-control": "no-store" } })
}

/**
 * Installs `vitehub({ trustProxy, sameOriginWrites })` on a Nitro app. `trustProxy` adds a `request` hook before the
 * hooks of other plugins. `sameOriginWrites` wraps `nitroApp.fetch`, the entry of every preset, so a cross-origin
 * write gets 403 before any middleware or route runs.
 */
export function installRequestPolicy(nitroApp: NitroAppLike, options: RequestPolicyOptions): void {
  if (options.trustProxy && nitroApp.hooks) {
    const requestHooks = nitroApp.hooks._hooks?.request
    if (Array.isArray(requestHooks)) requestHooks.unshift(trustForwardedProto)
    else nitroApp.hooks.hook("request", trustForwardedProto)
  }
  const sameOriginWrites = options.sameOriginWrites
  const fetch = nitroApp.fetch
  if (!sameOriginWrites || !(fetch instanceof Function)) return
  nitroApp.fetch = (request: Request, ...rest: unknown[]) => isCrossOriginWrite(request, sameOriginWrites.exclude)
    ? crossOriginWriteResponse()
    : Reflect.apply(fetch, nitroApp, [request, ...rest])
}
