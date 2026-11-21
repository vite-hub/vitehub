/** The headers that make a page cross-origin isolated, which a WebContainer needs. */
export const webContainerHeaders: Readonly<Record<string, string>> = Object.freeze({
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Opener-Policy": "same-origin",
})

/** Removes trailing slashes without changing the root path. */
export function normalizeWebContainerPath(path: string): string {
  return path.replace(/\/+$/, "") || "/"
}

/** Returns true when `pathname` matches one of the route patterns. `/playground/**` also matches `/playground`. */
export function matchesWebContainerRoute(pathname: string, routes: readonly string[]): boolean {
  const path = normalizeWebContainerPath(pathname)
  return routes.some((route) => {
    const pattern = normalizeWebContainerPath(route)
    if (pattern.endsWith("/**")) {
      const base = pattern.slice(0, -3) || "/"
      return base === "/" || path === base || path.startsWith(`${base}/`)
    }
    return path === pattern
  })
}
