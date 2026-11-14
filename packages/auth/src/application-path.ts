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

/** Characters that H3 percent-encodes in a route, as its `normalizeRoute()` does. */
const routeEncodeRE = /[^!-~]|["#<>^`]/gu

/** Escapes of characters that need no escape in a path. H3 decodes them before it routes a request. */
const needlessEscapeRE = /%(?:2[146-9A-E]|3[0-9ABD]|4[0-9A-F]|5[0-9ABDF]|6[1-9A-F]|7[0-9ACE])/gi

/**
 * The path as the Nitro router reads it, so that two spellings of one path give the same string. H3 decodes needless
 * escapes, such as `%62` for `b`, and rou3 ignores one trailing slash. The other escapes get upper-case hex digits.
 */
export function canonicalAccessPath(path: string): string {
  const canonical = path
    .replace(routeEncodeRE, encodeURIComponent)
    .replace(needlessEscapeRE, escape => String.fromCharCode(Number.parseInt(escape.slice(1), 16)))
    .replace(/%[\da-f]{2}/gi, escape => escape.toUpperCase())
  return canonical.length > 1 && canonical.endsWith("/") ? canonical.slice(0, -1) : canonical
}

/**
 * The error message for an access route that uses route pattern syntax or a dot segment, or undefined for a literal
 * path. Only a final `/**` is a pattern. The access middleware does not read `*`, `:name`, `(`, `{`, or `?` as
 * patterns, so such a route would guard nothing. H3 decodes escapes such as `%3A` and resolves `.` and `..` in a handler
 * route, so the check reads the route after the same decoding.
 */
export function accessRouteSyntaxError(route: string, label: string): string | undefined {
  const path = canonicalAccessPath(route.endsWith("/**") ? route.slice(0, -3) : route)
  if (path.split("/").some(segment => segment === "." || segment === ".."))
    return `\`defineAuth()\` ${label} has a \`.\` or \`..\` segment in ${JSON.stringify(route)}. Access routes match literal paths, so write the path without dot segments.`
  const syntax = /[*:(){}?\\]/.exec(path)?.[0]
  if (!syntax) return
  return `\`defineAuth()\` ${label} uses \`${syntax}\` in ${JSON.stringify(route)}. Access routes match literal paths, and only a final \`/**\` matches the paths below a route.`
}

/**
 * The path that an access route guards below the base URL, as the access middleware matches it. A route that ends with
 * `/**` is recursive: it guards `path` and every path below it, and an empty `path` guards every path. All other
 * characters of the route are literal. The path is canonical, see `canonicalAccessPath()`.
 */
export function resolveAccessRoutePath(route: string, baseURL = authApplicationBaseURL()): { path: string, recursive: boolean } {
  const recursive = route.endsWith("/**")
  // Route registration drops all trailing empty segments; request routing drops only one slash.
  const literal = (recursive ? route.slice(0, -3) : route).replace(/\/+$/, "") || "/"
  const resolved = canonicalAccessPath(prefixApplicationPath(baseURL, literal))
  return { path: recursive && resolved === "/" ? "" : resolved, recursive }
}
