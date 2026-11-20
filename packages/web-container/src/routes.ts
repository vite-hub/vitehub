/** The headers that make a page cross-origin isolated, which a WebContainer needs. */
export const webContainerHeaders: Readonly<Record<string, string>> = Object.freeze({
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Opener-Policy": "same-origin",
})

/** Returns true when `pathname` matches one of the route patterns. `/playground/**` also matches `/playground`. */
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
