import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin } from "vite"

/** The headers that make a page cross-origin isolated, which a WebContainer needs. */
export const webContainerHeaders: Readonly<Record<string, string>> = Object.freeze({
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Opener-Policy": "same-origin",
})

export interface WebContainerVitePluginOptions {
  /**
   * Pages that boot a WebContainer. `/playground` matches that path only. `/playground/**` matches it and every path below it.
   * Other pages keep their headers, so cross-origin embeds there keep working.
   */
  routes: readonly string[]
}

/** Returns true when `pathname` matches one of the route patterns. */
export function matchesWebContainerRoute(pathname: string, routes: readonly string[]): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
  return routes.some((route) => {
    if (route.endsWith("/**")) {
      const base = route.slice(0, -3) || "/"
      return base === "/" || path === base || path.startsWith(`${base}/`)
    }
    return path === (route.length > 1 ? route.replace(/\/+$/, "") : route)
  })
}

/**
 * Sets the cross-origin isolation headers on the configured routes in `vite dev` and `vite preview`.
 *
 * In production, set the same headers with Nitro route rules:
 * `routeRules: { "/playground/**": { headers: webContainerHeaders } }`.
 */
export function hubWebContainer(options: WebContainerVitePluginOptions): Plugin {
  const routes = [...options.routes]
  if (!routes.length) throw new TypeError("hubWebContainer() needs at least one route, such as \"/playground/**\".")
  for (const route of routes) {
    if (!route.startsWith("/")) throw new TypeError(`hubWebContainer() route "${route}" must start with "/".`)
  }

  function setHeaders(request: IncomingMessage, response: ServerResponse, next: () => void) {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname
    if (matchesWebContainerRoute(pathname, routes)) {
      for (const [name, value] of Object.entries(webContainerHeaders)) response.setHeader(name, value)
    }
    next()
  }

  return {
    name: "@vite-hub/web-container/vite",
    configureServer(server) {
      server.middlewares.use(setHeaders)
    },
    configurePreviewServer(server) {
      server.middlewares.use(setHeaders)
    },
  }
}
