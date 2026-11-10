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

/** Prefix an application path, such as the Auth Base Path, with the application base path. */
export function resolveAuthMountPath(path: string): string {
  return prefixApplicationPath(typeof __VITEHUB_AUTH_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_AUTH_APP_BASE_URL__, path)
}
