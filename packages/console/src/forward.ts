/**
 * The Console page calls `/p/<project>/_vitehub/...` on the Console origin. The Console server sends that call to the
 * project with the project's token, so the browser never holds the token and the project needs no CORS.
 */

/** The data routes of a project: the operation RPC, the Console API routes, and the page tools session. */
const forwardedPath = /^\/_vitehub\/(?:rpc\/.|api\/.|page\/session$)/
const forwardedMethods = new Set(["GET", "HEAD", "POST", "PUT", "DELETE"])
/** Cookies, `Origin`, and `Authorization` of the Console page never reach the project. */
const requestHeaders = ["accept", "content-type", "if-none-match", "x-vitehub-console"]
/** Set-Cookie never reaches the Console page. Fetch decodes the body, so the encoding and length headers stay out. */
const responseHeaders = ["cache-control", "etag", "last-modified", "www-authenticate"]

/** Largest file of one call. Files travel as base64 in the JSON body, such as in `media.upload` and `blob.put`. */
export const maxForwardFileBytes = 9 * 1024 * 1024
/** Base64 makes a file a third larger. The other 64 KiB hold the rest of the JSON envelope. */
export const maxForwardBodyBytes = Math.ceil(maxForwardFileBytes / 3) * 4 + 64 * 1024
const tooLarge = () => problem(413, "CONSOLE_FORWARD_TOO_LARGE", "The request body is too large. The Console sends files of up to 9 MiB.")

export interface ForwardTarget {
  /** The project URL: its origin and its application mount, such as `https://app.example.com/portal`. */
  url: string
  /** The project token. The Console sends it as `Authorization: Bearer`. */
  token: string
}

function problem(status: number, code: string, message: string): Response {
  return Response.json({ code, message, ok: false, status }, { headers: { "cache-control": "no-store" }, status })
}

/**
 * Send one Console call to a project. `path` is the app path after the project prefix, with its query, such as
 * `/_vitehub/rpc/__call`. Only the data routes go through. The project's answer comes back with its status and body,
 * and without cookies. The Console contains project content so it cannot execute on the Console origin.
 */
export async function forwardProjectRequest(request: Request, target: ForwardTarget, path: string, send: typeof fetch = fetch): Promise<Response> {
  if (!forwardedMethods.has(request.method)) return problem(405, "CONSOLE_FORWARD_METHOD", `The Console does not send ${request.method} requests to a project.`)
  const base = new URL(target.url)
  // The URL parser resolves `..` and its encoded forms, so the check reads the path that the project would get.
  const upstream = new URL(`${base.origin}${base.pathname.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`)
  const appPath = upstream.pathname.slice(base.pathname.replace(/\/+$/, "").length)
  if (upstream.origin !== base.origin || !upstream.pathname.startsWith(base.pathname.replace(/\/+$/, "")) || !forwardedPath.test(appPath)) {
    return problem(404, "CONSOLE_FORWARD_PATH", "The Console sends only the Operations endpoint calls of a project.")
  }

  let body: ArrayBuffer | undefined
  if (request.method !== "GET" && request.method !== "HEAD") {
    const declared = Number(request.headers.get("content-length") ?? 0)
    if (declared > maxForwardBodyBytes) return tooLarge()
    body = await request.arrayBuffer()
    if (body.byteLength > maxForwardBodyBytes) return tooLarge()
  }

  const headers = new Headers({ authorization: `Bearer ${target.token}` })
  for (const name of requestHeaders) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }

  let response: Response
  try {
    response = await send(upstream, { body, headers, method: request.method, redirect: "manual", signal: request.signal })
  }
  catch {
    return problem(502, "CONSOLE_FORWARD_UNREACHABLE", `The Console could not reach ${base.host}.`)
  }
  // A redirect could send the token's request to another address, so the Console stops there.
  if (response.status >= 300 && response.status < 400) {
    return problem(502, "CONSOLE_FORWARD_REDIRECT", `${base.host} answered with a redirect. Link the project with the URL that serves it.`)
  }

  // Fetch clients can still read JSON and binary bodies. Documents get no Console origin or script access,
  // and an inert media type with nosniff also prevents execution when loaded as a script or other resource.
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  const out = new Headers({
    "content-disposition": "attachment",
    "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
    "content-type": type === "application/json" ? "application/json" : "application/octet-stream",
    "x-content-type-options": "nosniff",
  })
  for (const name of responseHeaders) {
    const value = response.headers.get(name)
    if (value !== null) out.set(name, value)
  }
  return new Response(request.method === "HEAD" ? null : response.body, { headers: out, status: response.status, statusText: response.statusText })
}
