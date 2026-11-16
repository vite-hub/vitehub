import { HTTPError } from "nitro/h3"
import { defineDiagnostics } from "nostics"
import { limitRequestBody } from "srvx/body-limit"

/** The resolved `vitehub({ security })` options that the generated Nitro plugin passes. */
export interface SecurityPolicy {
  /** Header names and values to add to every response that does not set the header itself. */
  headers: Array<[name: string, value: string]>
  /** The largest request body in bytes, or `undefined` for no limit. */
  maxBodySize?: number
}

interface NitroAppLike {
  fetch?: unknown
}

// A small catalog of its own, so the server bundle does not take the whole `vite-hub` catalog for one code.
const securityDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    VITE_HUB_REQUEST_BODY_TOO_LARGE: {
      why: ({ limit }: { limit: number }) => `The request body is larger than ${limit} bytes, the \`security.maxBodySize\` of this app.`,
      fix: "Send a smaller body. When a route must take larger bodies, such as file uploads, raise `security.maxBodySize` in `vitehub()`.",
    },
  },
})

/** The error for a body over the limit. H3 answers it with 413 and `data.code`. */
function bodyTooLargeError(limit: number): HTTPError {
  const { name: code, why, fix, docs } = securityDiagnostics.VITE_HUB_REQUEST_BODY_TOO_LARGE({ limit })
  return new HTTPError({ status: 413, statusText: "Content Too Large", message: why, data: { code, fix, docs } })
}

/** The 413 answer to a request whose `Content-Length` is over the limit, in the JSON shape that H3 gives the same error. */
export function bodyTooLargeResponse(limit: number): Response {
  return Response.json(bodyTooLargeError(limit).toJSON(), { status: 413, statusText: "Content Too Large", headers: { "cache-control": "no-store" } })
}

function declaredLength(request: Request): number {
  const value = request.headers.get("content-length")
  return value && /^\d+$/.test(value) ? Number(value) : 0
}

/**
 * Adds each header that the response does not set itself, so a route that sets a stricter value, such as
 * `X-Frame-Options: DENY`, keeps it. A WebSocket upgrade (101) is left as it is.
 */
export function addSecurityHeaders(response: Response, headers: SecurityPolicy["headers"]): Response {
  if (response.status === 101) return response
  const missing = headers.filter(([name]) => !response.headers.has(name))
  if (missing.length === 0) return response
  try {
    for (const [name, value] of missing) response.headers.set(name, value)
    return response
  }
  catch {
    // The headers of a response from `fetch()` or `Response.redirect()` are immutable. Copy the response.
    const copy = new Response(response.body, response)
    for (const [name, value] of missing) copy.headers.set(name, value)
    return copy
  }
}

/**
 * Installs `vitehub({ security })` on a Nitro app. It wraps `nitroApp.fetch`, the entry of every preset, so it covers
 * every route, middleware, error page, and static file that Nitro serves. A body whose `Content-Length` is over
 * `maxBodySize` gets 413 before any middleware or route runs. A body without `Content-Length` is counted while a route
 * reads it, and the read fails with a 413 `HTTPError` when it passes the limit.
 */
export function installSecurity(nitroApp: NitroAppLike, policy: SecurityPolicy): void {
  const fetch = nitroApp.fetch
  if (!(fetch instanceof Function)) return
  const { headers, maxBodySize } = policy
  nitroApp.fetch = async (request: Request, ...rest: unknown[]) => {
    let input = request
    if (maxBodySize !== undefined) {
      if (declaredLength(request) > maxBodySize) return addSecurityHeaders(bodyTooLargeResponse(maxBodySize), headers)
      input = limitRequestBody(request, maxBodySize, { createError: bodyTooLargeError })
    }
    const response: Response = await Reflect.apply(fetch, nitroApp, [input, ...rest])
    return headers.length > 0 ? addSecurityHeaders(response, headers) : response
  }
}
