import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin } from "vite"

import { cloudflareWebContainerHeaders } from "./cloudflare.ts"
import { webContainerErrorDiagnostics } from "./error-diagnostics.ts"
import { matchesWebContainerRoute, normalizeWebContainerPath, webContainerHeaders } from "./routes.ts"

export { matchesWebContainerRoute, webContainerHeaders } from "./routes.ts"

/** `webContainer` options of `vitehub()`. */
export interface WebContainerOptions {
  /**
   * Pages that boot a WebContainer. `/playground` matches that path only. `/playground/**` matches it and every path below it.
   * Other pages keep their headers, so cross-origin embeds there keep working.
   */
  routes: readonly string[]
}

interface NitroRouteRule {
  headers?: Record<string, string>
  [key: string]: unknown
}

/** Checks the routes and returns a copy. Throws a coded error for a missing or relative route. */
export function resolveWebContainerRoutes(options: WebContainerOptions): string[] {
  const routes = [...options.routes ?? []]
  if (!routes.length) throw webContainerErrorDiagnostics.WEB_CONTAINER_ROUTES_MISSING()
  for (const route of routes) {
    if (typeof route !== "string" || !route.startsWith("/")) throw webContainerErrorDiagnostics.WEB_CONTAINER_ROUTE_INVALID({ route: String(route) })
  }
  return routes
}

/**
 * The Nitro route rules that send the isolation headers on `routes`. `/playground/**` gives a rule for `/playground` and
 * one for the paths below it. A rule that the app already has keeps its other keys and headers.
 */
export function webContainerRouteRules(routes: readonly string[], existing: Record<string, NitroRouteRule> = {}): Record<string, NitroRouteRule> {
  const rules: Record<string, NitroRouteRule> = {}
  for (const route of routes) {
    const path = normalizeWebContainerPath(route)
    const base = path.endsWith("/**") ? path.slice(0, -3) : undefined
    for (const pattern of base === undefined ? [path] : [base || "/", path]) {
      const rule = existing[pattern] ?? {}
      rules[pattern] = { ...rule, headers: { ...rule.headers, ...webContainerHeaders } }
    }
  }
  return rules
}

/**
 * Makes the WebContainer pages cross-origin isolated. `vitehub({ webContainer })` adds it for you. It sets the headers in
 * `vite dev` and `vite preview`, and adds Nitro route rules for the built server and for Nuxt.
 */
export function webContainerVitePlugin(options: WebContainerOptions): Plugin {
  const routes = resolveWebContainerRoutes(options)
  const staticHeaders = cloudflareWebContainerHeaders(routes, Object.keys(webContainerRouteRules(routes)))

  function setHeaders(request: IncomingMessage, response: ServerResponse, next: () => void) {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname
    if (matchesWebContainerRoute(pathname, routes)) {
      for (const [name, value] of Object.entries(webContainerHeaders)) response.setHeader(name, value)
    }
    next()
  }

  return {
    name: "@vite-hub/web-container/vite",
    config(config, { command }) {
      // SAFETY: Nitro reads its options from the `nitro` key of the Vite config.
      const viteConfig = config as typeof config & { nitro?: { modules?: unknown[], routeRules?: Record<string, NitroRouteRule> } }
      const nitro = (viteConfig.nitro ??= {})
      nitro.routeRules = { ...nitro.routeRules, ...webContainerRouteRules(routes, nitro.routeRules) }
      if (command === "build") {
        const modules = (nitro.modules ??= [])
        if (!modules.includes(staticHeaders)) modules.push(staticHeaders)
      }
    },
    configureServer(server) {
      server.middlewares.use(setHeaders)
    },
    configurePreviewServer(server) {
      server.middlewares.use(setHeaders)
    },
  }
}

/**
 * @deprecated Use `vitehub({ webContainer: { routes } })`. It sets the headers in dev, preview, and production, and
 * Nuxt pages load a new document when a link crosses into or out of these routes.
 */
export function hubWebContainer(_options?: WebContainerOptions): never {
  throw webContainerErrorDiagnostics.WEB_CONTAINER_PLUGIN_MOVED()
}
