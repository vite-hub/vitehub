export function consoleAuthMountBase(baseURL: string): string {
  // Vite asset bases can be relative or absolute URLs; auth routes use only the application pathname.
  if (!baseURL || baseURL === "./") return ""
  if (/^https?:\/\//.test(baseURL)) baseURL = new URL(baseURL).pathname
  const segments = baseURL.split("/").filter(Boolean)
  return segments.length ? `/${segments.join("/")}` : ""
}

export function consoleAuthPath(baseURL: string, path: string): string {
  return `${consoleAuthMountBase(baseURL)}${path}`
}

/** Normalize a team domain or issuer URL to the Access issuer origin. */
export function cloudflareAccessIssuer(teamDomain: string): string | undefined {
  const value = teamDomain.trim().replace(/\/+$/, "")
  if (!value) return undefined
  let url: URL
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`)
  }
  catch {
    return undefined
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return undefined
  return url.origin
}

/** Match guards against H3's routed path, while retaining the original request for Auth. */
export function consoleEventPath(event: object, request: Request): string {
  if ("url" in event && event.url instanceof URL) return event.url.pathname
  // H3 1 has already decoded and possibly rewritten this path before routing.
  // Its router treats decoded question marks as query boundaries.
  if ("path" in event && typeof event.path === "string") return event.path.split("?", 1)[0]!
  // Bare Requests have no routed path. Apply H3 2's canonical escape handling.
  return canonicalRoutePath(new URL(request.url).pathname)
}

// Escapes of characters that a path does not need to escape. H3 2 decodes them before it routes a request.
const needlessPathEscape = /%(?:2[146-9A-E]|3[0-9ABD]|4[0-9A-F]|5[0-9ABDF]|6[1-9A-F]|7[0-9ACE])/gi

/**
 * The route that H3 2's `normalizeRoute()` gives a URL pathname, so a guard matches the handler that H3 2 selects.
 * It does not import `h3`, because Nuxt 4 bundles every `h3` import as its own h3 1, which has no `normalizeRoute()`.
 */
function canonicalRoutePath(pathname: string): string {
  const path = pathname.replace(needlessPathEscape, escape => String.fromCharCode(Number.parseInt(escape.slice(1), 16)))
  if (!path.includes("/.")) return path
  const segments: string[] = []
  let dot = false
  for (const segment of path.split("/")) {
    dot = segment === "." || segment === ".."
    if (!dot) segments.push(segment)
    else if (segment.length === 2 && segments.length > 1) segments.pop()
  }
  if (dot) segments.push("")
  return segments.join("/")
}
