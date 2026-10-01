import * as v from "valibot"

import { connectionError, isConnectionError } from "./errors.ts"
import { CONNECTIONS_BASE_PATH } from "./runtime/core.ts"

import type { ConnectionsRuntime } from "./runtime/core.ts"
import type { ConnectionActor } from "./types.ts"

export interface ConnectionsAccess {
  actor: ConnectionActor
  /** Admins can start, refresh, and disconnect Connections. Others can only read. */
  admin: boolean
}

export interface ConnectionsHandlerOptions {
  /** Checks the caller of the management route. Return `null` to reject it. */
  authenticate: (request: Request, event: unknown) => ConnectionsAccess | null | Promise<ConnectionsAccess | null>
  basePath?: string
  /** Page to open after the OAuth callback. Default: `/`. */
  returnTo?: (name: string, outcome: "connected" | "failed") => string
  runtime: ConnectionsRuntime
}

const name = v.pipe(v.string(), v.minLength(1), v.maxLength(128))
const manageInput = v.variant("action", [
  v.object({ action: v.literal("list") }),
  v.object({ action: v.literal("inspect"), name }),
  v.object({ action: v.literal("activity"), before: v.optional(v.pipe(v.string(), v.maxLength(128))), limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))), name: v.optional(name) }),
  v.object({ action: v.literal("start"), name }),
  v.object({ action: v.literal("refresh"), name }),
  v.object({ action: v.literal("disconnect"), name }),
])
const stateCookie = "vitehub_connection_state"

const securityHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { headers: securityHeaders, status })
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ ...securityHeaders, location, "referrer-policy": "no-referrer" })
  if (cookie) headers.append("set-cookie", cookie)
  return new Response(null, { headers, status: 302 })
}

async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw connectionError("invalid")
  const decoder = new TextDecoder()
  let size = 0
  let text = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 65_536) {
        await reader.cancel()
        throw connectionError("invalid")
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  }
  catch {
    throw connectionError("invalid")
  }
  finally {
    reader.releaseLock()
  }
}

function errorResponse(error: unknown, cookie?: string): Response {
  if (!isConnectionError(error)) return json({ code: "CONNECTIONS_FAILED", message: "Connection request failed." }, 500)
  const status = error.code === "CONNECTIONS_NOT_FOUND"
    ? 404
    : error.code === "CONNECTIONS_INVALID"
      ? 400
      : error.code === "CONNECTIONS_DENIED" || error.code === "CONNECTIONS_APPROVAL_REQUIRED"
        ? 403
        : error.code === "CONNECTIONS_NOT_CONFIGURED" || error.code === "CONNECTIONS_UNAVAILABLE"
          ? 503
          : 409
  const response = json({ code: error.code, message: error.message }, status)
  if (cookie) response.headers.append("set-cookie", cookie)
  return response
}

function readCookie(request: Request, key: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [cookieName, ...value] = part.trim().split("=")
    if (cookieName === key) return decodeURIComponent(value.join("="))
  }
}

function cookie(path: string, value: string, secure: boolean, maxAge: number): string {
  return `${stateCookie}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
}

function segment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value)
    return v.is(name, decoded) ? decoded : undefined
  }
  catch {
    return undefined
  }
}

/**
 * Handles `POST <base>/manage`, `GET <base>/:name/connect`, and `GET <base>/:name/callback`.
 * Mount it only behind the Console guard. The connect routes need a single-use ticket and a state cookie.
 */
export function createConnectionsHandler(options: ConnectionsHandlerOptions): (request: Request, event?: unknown) => Promise<Response> {
  const basePath = (options.basePath ?? CONNECTIONS_BASE_PATH).replace(/\/$/, "")
  const returnTo = options.returnTo ?? (() => "/")

  async function manage(request: Request, event: unknown): Promise<Response> {
    const origin = request.headers.get("origin")
    if (origin ? origin !== new URL(request.url).origin : !/^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "")) {
      return json({ message: "Request origin is not allowed." }, 403)
    }
    const access = await options.authenticate(request, event)
    if (!access) return json({ message: "Authentication required." }, 401)
    const parsed = v.safeParse(manageInput, await readBody(request))
    if (!parsed.success) throw connectionError("invalid")
    const input = parsed.output
    const { runtime } = options
    if ((input.action === "start" || input.action === "refresh" || input.action === "disconnect") && !access.admin) {
      return json({ code: "CONNECTIONS_DENIED", message: "This caller cannot change Connections." }, 403)
    }
    switch (input.action) {
      case "list": return json({ admin: access.admin, connections: await runtime.list(event) })
      case "inspect": return json({ admin: access.admin, connection: await runtime.inspect(input.name, event) })
      case "activity": return json({ events: await runtime.activity({ before: input.before, connection: input.name, event, limit: input.limit }) })
      case "start": return json(await runtime.start(input.name, { actor: access.actor, event, origin: new URL(request.url).origin }))
      case "refresh": return json({ connection: await runtime.refresh(input.name, { actor: access.actor, event }) })
      case "disconnect": return json({ connection: await runtime.disconnect(input.name, { actor: access.actor, event }) })
    }
  }

  return async (request, event) => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(`${basePath}/`)) return json({ message: "Not found." }, 404)
    const path = url.pathname.slice(basePath.length + 1).split("/")
    try {
      if (path.length === 1 && path[0] === "manage") {
        if (request.method !== "POST") return json({ message: "Method not allowed." }, 405)
        return await manage(request, event)
      }
      const connection = path.length === 2 ? segment(path[0]!) : undefined
      if (!connection || (path[1] !== "connect" && path[1] !== "callback")) return json({ message: "Not found." }, 404)
      if (request.method !== "GET") return json({ message: "Method not allowed." }, 405)
      // Connect and callback change a Connection, so they need the same access as management changes.
      const access = await options.authenticate(request, event)
      if (!access) return json({ message: "Authentication required." }, 401)
      if (!access.admin) return json({ code: "CONNECTIONS_DENIED", message: "This caller cannot change Connections." }, 403)
      const cookiePath = `${basePath}/${encodeURIComponent(connection)}`
      const secure = url.protocol === "https:"
      if (path[1] === "connect") {
        const ticket = url.searchParams.get("ticket")
        if (!ticket || ticket.length > 128) throw connectionError("invalid")
        const opened = await options.runtime.open({ event, name: connection, ticket })
        return redirect(opened.authorizationUrl, cookie(cookiePath, opened.state, secure, 600))
      }
      const clear = cookie(cookiePath, "", secure, 0)
      try {
        await options.runtime.callback({
          code: url.searchParams.get("code") ?? undefined,
          cookieState: readCookie(request, stateCookie),
          error: url.searchParams.get("error") ?? undefined,
          event,
          name: connection,
          state: url.searchParams.get("state") ?? undefined,
        })
        return redirect(returnTo(connection, "connected"), clear)
      }
      catch (error) {
        if (isConnectionError(error, "invalid")) return errorResponse(error, clear)
        return redirect(returnTo(connection, "failed"), clear)
      }
    }
    catch (error) {
      return errorResponse(error)
    }
  }
}
