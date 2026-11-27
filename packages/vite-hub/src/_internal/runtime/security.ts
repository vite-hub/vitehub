import { HTTPError } from "nitro/h3"
import { defineDiagnostics } from "nostics"
import type { ServerRequest } from "srvx"
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
 * srvx's `limitRequestBody()` reads `formData()` and `blob()` from a `Response` without the request headers, so a form
 * loses its `multipart/form-data` boundary and `formData()` throws. These two reads keep the headers. The other reads
 * and `body` go to srvx, which counts the bytes.
 */
function limitBody(request: Request, limit: number): Request {
  const limited = limitRequestBody(request, limit, { createError: bodyTooLargeError })
  if (limited === request) return request
  return new Proxy(limited, {
    get(target, prop) {
      if (prop === "formData" || prop === "blob") return async () => new Response(target.body, { headers: request.headers })[prop]()
      if (prop === "clone") return () => limitBody(request.clone(), limit)
      return Reflect.get(target, prop)
    },
  })
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
 * reads it, and the read fails with a 413 `HTTPError` when it passes the limit. Node bodies are checked before
 * dispatch through the Fetch bridge, which also keeps native handlers behind these controls.
 */
export function installSecurity(nitroApp: NitroAppLike, policy: SecurityPolicy): void {
  const fetch = nitroApp.fetch
  if (!(fetch instanceof Function)) return
  const { headers, maxBodySize } = policy
  nitroApp.fetch = async (request: Request, ...rest: unknown[]) => {
    let input = request
    if (maxBodySize !== undefined) {
      if (declaredLength(request) > maxBodySize) return addSecurityHeaders(bodyTooLargeResponse(maxBodySize), headers)
      input = limitBody(request, maxBodySize)
    }
    if ((request as Partial<ServerRequest>).runtime?.node) {
      // Native Node handlers otherwise read and write the original socket, bypassing both Fetch controls.
      // Use srvx's Fetch-to-Node bridge instead. Buffer the bounded body first, since the bridge turns
      // body read errors into a generic 500 rather than the diagnostic 413.
      let body: ArrayBuffer | null = null
      if (maxBodySize !== undefined && input.body) {
        try {
          body = await input.arrayBuffer()
        }
        catch (error) {
          if (error instanceof HTTPError && error.status === 413) return addSecurityHeaders(bodyTooLargeResponse(maxBodySize), headers)
          throw error
        }
      }
      const source = input as ServerRequest
      input = Object.assign(new Request(source.url, {
        method: source.method,
        headers: source.headers,
        signal: source.signal,
        body: body ?? source.body,
        duplex: "half",
      } as RequestInit), {
        _url: source._url,
        runtime: { ...source.runtime, node: undefined },
        context: source.context,
        ip: source.ip,
        waitUntil: source.waitUntil,
      })
      // Keep the shared URL used by Nitro request hooks such as trustProxy.
      Object.defineProperty(input, "url", { get: () => source.url })
    }
    const response: Response = await Reflect.apply(fetch, nitroApp, [input, ...rest])
    return headers.length > 0 ? addSecurityHeaders(response, headers) : response
  }
}
