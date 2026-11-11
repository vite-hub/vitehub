/**
 * The path below which the host serves Auth, such as Nuxt `app.baseURL` or Nitro `baseURL`.
 * The Auth Nitro integration replaces it in server code and the Nuxt module defines it in client code.
 */
declare const __VITEHUB_AUTH_APP_BASE_URL__: string | undefined

/** Return the application base path without a trailing slash, or an empty string at the root. */
function authApplicationBasePath(): string {
  const configured = typeof __VITEHUB_AUTH_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_AUTH_APP_BASE_URL__
  const segments = configured.split("/").filter(Boolean)
  return segments.length ? `/${segments.join("/")}` : ""
}

/**
 * Prefix an application path, such as the Auth Base Path, with the application base path.
 * A path that already starts with the base path is returned unchanged, so a caller such as Console Auth
 * that mounts its own paths below the base path is not prefixed twice.
 */
export function resolveAuthMountPath(path: string): string {
  const base = authApplicationBasePath()
  if (!base || path === base || path.startsWith(`${base}/`)) return path
  return `${base}${path}`
}

/**
 * Prefix a Nitro route with the application base path, always. Nitro serves each handler route below its `baseURL`, so
 * this is the path of the request that reaches the route, even when the route itself starts with the base path.
 */
export function resolveAuthRoutePath(route: string): string {
  return `${authApplicationBasePath()}${route}`
}
