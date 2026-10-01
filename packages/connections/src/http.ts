import * as v from "valibot"

import { isConnectionError } from "./errors.ts"
import { CONNECTIONS_ROUTE } from "./route.ts"
import { getConnectionsRuntime } from "./runtime/state.ts"

import type { ConnectionsRuntime } from "./runtime.ts"

export { CONNECTIONS_ROUTE }

const MAX_BODY_BYTES = 64 * 1024
const STATE_COOKIE = "vitehub_connection_state"

export interface ConnectionsHandlerOptions {
  /** Identify the person who manages Connections, for example from Console auth. Defaults to `user:local`. */
  actor?: (request: Request) => string | undefined | Promise<string | undefined>
  runtime?: () => ConnectionsRuntime
}

const name = v.pipe(v.string(), v.minLength(1))
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(256))
const actionSchema = v.variant("action", [
  v.object({ action: v.literal("list") }),
  v.object({ action: v.literal("inspect"), name }),
  v.object({ action: v.literal("authorize"), name, redirectUri: v.pipe(v.string(), v.url()) }),
  v.object({ action: v.literal("complete"), code: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)), state: id }),
  v.object({ action: v.literal("revoke"), name }),
  v.object({ action: v.literal("activity"), before: v.optional(id), name }),
  v.object({ action: v.literal("approvals"), name: v.optional(name), status: v.optional(v.picklist(["approved", "denied", "executed", "failed", "pending"])) }),
  v.object({ action: v.literal("approve"), id }),
  v.object({ action: v.literal("deny"), id }),
])

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "cache-control": "no-store", "content-type": "application/json", ...headers },
    status,
  })
}

function errorResponse(error: unknown): Response {
  if (isConnectionError(error)) {
    const status = { approval_required: 409, denied: 403, invalid: 400, provider: 502, reauth_required: 409 }[error.reason]
    return json({ error: { code: error.code, message: error.message, ...(error.requestId ? { requestId: error.requestId } : {}) } }, status)
  }
  return json({ error: { code: "CONNECTION_FAILED", message: "The Connections request failed." } }, 500)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
}

function page(title: string, message: string, status: number): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;margin:4rem auto;max-width:32rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`, {
    headers: { "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "content-type": "text/html; charset=utf-8" },
    status,
  })
}

function cookie(request: Request, key: string): string | undefined {
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const [cookieName, ...value] = part.trim().split("=")
    if (cookieName === key) return value.join("=")
  }
  return undefined
}

function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin")
  if (origin && origin !== url.origin) return false
  return request.headers.get("sec-fetch-site") !== "cross-site"
}

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

async function managementActor(options: ConnectionsHandlerOptions, request: Request): Promise<string> {
  const actor = await options.actor?.(request)
  return actor && /^user:[^\s]{1,256}$/.test(actor) ? actor : "user:local"
}

/**
 * Management API for Connections. Mount it only where the caller is trusted:
 * the development server, or behind Console auth in production.
 *
 * - `POST /_vitehub/connections` runs one JSON action.
 * - `GET /_vitehub/connections/connect/:name` starts the web authorization flow.
 * - `GET /_vitehub/connections/callback` completes it.
 */
export function createConnectionsHandler(options: ConnectionsHandlerOptions = {}): (request: Request) => Promise<Response> {
  const runtime = () => (options.runtime ?? getConnectionsRuntime)()
  return async (request) => {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, "")
    try {
      if (request.method === "GET" && path.startsWith(`${CONNECTIONS_ROUTE}/connect/`)) {
        const connection = v.safeParse(name, decodeURIComponent(path.slice(`${CONNECTIONS_ROUTE}/connect/`.length)))
        if (!connection.success) return page("Connection failed", "The Connection name is invalid.", 400)
        const authorization = await runtime().authorize({
          actor: await managementActor(options, request),
          name: connection.output,
          redirectUri: `${url.origin}${CONNECTIONS_ROUTE}/callback`,
        })
        return new Response(null, {
          headers: {
            "cache-control": "no-store",
            location: authorization.url,
            "set-cookie": `${STATE_COOKIE}=${authorization.state}; Path=${CONNECTIONS_ROUTE}; HttpOnly; SameSite=Lax; Max-Age=600${url.protocol === "https:" ? "; Secure" : ""}`,
          },
          status: 302,
        })
      }
      if (request.method === "GET" && path === `${CONNECTIONS_ROUTE}/callback`) {
        const state = url.searchParams.get("state")
        const code = url.searchParams.get("code")
        const clear = `${STATE_COOKIE}=; Path=${CONNECTIONS_ROUTE}; HttpOnly; SameSite=Lax; Max-Age=0`
        if (url.searchParams.get("error")) return page("Connection cancelled", "The provider did not grant access.", 400)
        if (!state || !code || cookie(request, STATE_COOKIE) !== state) return page("Connection failed", "The authorization response does not match this browser. Start the connection again.", 400)
        const result = await runtime().complete({ code, state })
        const response = page("Connected", `Connection "${result.name}" is connected${result.account?.email ? ` as ${result.account.email}` : ""}. You can close this tab.`, 200)
        response.headers.append("set-cookie", clear)
        return response
      }
      if (path !== CONNECTIONS_ROUTE) return json({ error: { code: "CONNECTION_NOT_FOUND", message: "Not found." } }, 404)
      if (request.method !== "POST") return json({ error: { code: "CONNECTION_METHOD", message: "Use POST." } }, 405, { allow: "POST" })
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !sameOrigin(request, url)) {
        return json({ error: { code: "CONNECTION_FORBIDDEN", message: "Cross-origin or non-JSON requests are not allowed." } }, 403)
      }
      const parsed = v.safeParse(actionSchema, await readBody(request))
      if (!parsed.success) return json({ error: { code: "CONNECTION_INVALID", message: "Invalid Connections request." } }, 400)
      const input = parsed.output
      const connections = runtime()
      const actor = await managementActor(options, request)
      switch (input.action) {
        case "list": return json({ connections: await connections.list() })
        case "inspect": return json({ connection: await connections.inspect(input.name) })
        case "authorize": return json(await connections.authorize({ actor, name: input.name, redirectUri: input.redirectUri }))
        case "complete": return json({ connection: await connections.complete(input) })
        case "revoke": return json({ connection: await connections.revoke({ actor, name: input.name }) })
        case "activity": return json({ activity: await connections.activity(input) })
        case "approvals": return json({ approvals: await connections.approvals({ ...(input.name ? { name: input.name } : {}), ...(input.status ? { status: input.status } : {}) }) })
        case "approve": return json(await connections.approve({ actor, id: input.id }))
        case "deny": return json({ approval: await connections.deny({ actor, id: input.id }) })
      }
    }
    catch (error) {
      if (request.method === "GET") {
        return page("Connection failed", isConnectionError(error) ? error.message : "The connection could not be completed.", isConnectionError(error) && error.reason === "invalid" ? 400 : 500)
      }
      return errorResponse(error)
    }
  }
}
