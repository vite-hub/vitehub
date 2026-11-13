/**
 * The path below which the host serves Auth, such as Nuxt `app.baseURL` or Nitro `baseURL`.
 * The Auth Nitro integration replaces it in server code and the Nuxt module defines it in client code.
 */
declare const __VITEHUB_AUTH_APP_BASE_URL__: string | undefined

/**
 * Prefix an application path with a base URL, such as Nitro `baseURL`. A path that already starts with the base path is
 * returned unchanged, so a caller such as Console Auth that mounts its own paths below the base path is not prefixed
 * twice.
 */
export function prefixApplicationPath(baseURL: string, path: string): string {
  const segments = baseURL.split("/").filter(Boolean)
  const base = segments.length ? `/${segments.join("/")}` : ""
  if (!base || path === base || path.startsWith(`${base}/`)) return path
  return `${base}${path}`
}

/**
 * Prefix an application path, such as the Auth Base Path, with the application base path: `appBaseURL` when given,
 * such as Nuxt's runtime `app.baseURL`, else the base path of the build.
 */
export function resolveAuthMountPath(path: string, appBaseURL?: string): string {
  return prefixApplicationPath(appBaseURL ?? authApplicationBaseURL(), path)
}

function authApplicationBaseURL(): string {
  return typeof __VITEHUB_AUTH_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_AUTH_APP_BASE_URL__
}

/**
 * The path that an access route guards below the base URL, as the access middleware matches it. A route that ends with
 * `/**` is recursive: it guards `path` and every path below it, and an empty `path` guards every path. All other
 * characters of the route are literal.
 */
export function resolveAccessRoutePath(route: string, baseURL = authApplicationBaseURL()): { path: string, recursive: boolean } {
  const recursive = route.endsWith("/**")
  const resolved = prefixApplicationPath(baseURL, recursive ? route.slice(0, -3) : route)
  return { path: recursive ? (resolved === "/" ? "" : resolved.replace(/\/$/, "")) : resolved, recursive }
}
