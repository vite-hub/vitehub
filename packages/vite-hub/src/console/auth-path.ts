import { normalizeRoute } from "h3"

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

/** The Web Request of an H3 event. Throws a `TypeError` for an event without one. */
export function consoleEventRequest(event: object): Request {
  const request: unknown = Reflect.get(event, "req")
  if (request instanceof Object && typeof Reflect.get(request, "url") === "string" && typeof Reflect.get(request, "method") === "string" && Reflect.get(request, "headers") instanceof Object) {
    // SAFETY: H3 events carry the Web Request of the call as `req`. The checks above reject other values.
    return request as Request
  }
  throw new TypeError("[vitehub] Expected an H3 event with a Web Request.")
}

/** Match guards against H3's routed path, while retaining the original request for Auth. */
export function consoleEventPath(event: object, request: Request): string {
  if ("url" in event && event.url instanceof URL) return event.url.pathname
  // Bare Requests have no routed path. Apply H3's canonical escape handling.
  return normalizeRoute(new URL(request.url).pathname)
}
