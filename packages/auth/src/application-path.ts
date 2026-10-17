/**
 * The path below which the host serves Auth, such as Nuxt `app.baseURL` or Nitro `baseURL`.
 * The Auth Nitro integration replaces it in server code and the Nuxt module defines it in client code.
 */
declare const __VITEHUB_AUTH_APP_BASE_URL__: string | undefined

/** Return the application base path without a trailing slash, or an empty string at the root. */
export function authApplicationBasePath(): string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Only host integrations inject this value; direct imports leave it undeclared.
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
