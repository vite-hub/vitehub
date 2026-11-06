import { isRuntimeResponse } from "@vite-hub/runtime/internal/runtime-type"

import { consoleDiagnosticBody, consoleStatusDiagnosticCode, isConsoleDiagnosticCode } from "../diagnostics.ts"

import type { ConsoleAccess } from "./access.ts"
import type { ConsoleRequestEvent } from "./request.ts"

/**
 * Browser origins that may call Console data routes from another origin, from `console.origins`. Generated Console
 * output installs them only with `auth: "token"`, the one mode that verifies a bearer token on these routes. Without
 * an installed list, every cross-origin call is rejected.
 */
const originsKey: unique symbol = Symbol.for("vitehub.console.origins")
// SAFETY: This module owns the process slot shared by separately bundled generated plugins and Console routes.
const scope = globalThis as typeof globalThis & { [originsKey]?: readonly string[] }

/** The Console data routes that answer a cross-origin call, below any application mount. */
const dataRoutes = ["/_vitehub/rpc/__call", "/_vitehub/rpc/__upload", "/_vitehub/auth/manage", "/_vitehub/env/manage", "/_vitehub/channels/replay"]

/** The request headers that a listed origin may send. The CLI surface and project headers stay same-origin. */
export const consoleCorsAllowedHeaders = "authorization, content-type, x-vitehub-console"

export function installConsoleOrigins(origins: readonly string[]): void {
  scope[originsKey] = Object.freeze([...origins])
}

export function installedConsoleOrigins(): readonly string[] {
  return scope[originsKey] ?? []
}

/** The `WWW-Authenticate` value of a Console data route that needs a bearer token. */
export function consoleBearerChallenge(parameters: { error?: "invalid_token" } = {}): string {
  return `Bearer realm="vitehub-console"${parameters.error ? `, error="${parameters.error}"` : ""}`
}

function header(event: ConsoleRequestEvent, name: string): string | undefined {
  // H3 1 sets `event.req` to the Node request, whose headers are a plain object.
  for (const source of [event.req?.headers, event.headers]) {
    if (source && "get" in source && source.get instanceof Function) {
      const value = source.get(name)
      if (value !== null) return value
    }
  }
  const raw = event.node?.req?.headers?.[name]
  return Array.isArray(raw) ? raw[0] : raw
}

function method(event: ConsoleRequestEvent): string {
  return (event.method ?? event.req?.method ?? event.node?.req?.method ?? "GET").toUpperCase()
}

function pathname(event: ConsoleRequestEvent): string {
  const value = event.node?.req?.originalUrl || event.req?.url || event.node?.req?.url || "/"
  return new URL(value, "http://vitehub.local").pathname
}

/** The `Origin` of the request when `console.origins` lists it. */
function listedOrigin(origin: string | null | undefined): string | undefined {
  return origin && installedConsoleOrigins().includes(origin) ? origin : undefined
}

/**
 * Whether a cross-origin request may reach a Console data route: `console.origins` lists its `Origin`, and the access
 * check accepted its `Authorization: Bearer` token. Only `auth: "token"` verifies a token on these routes, so a cookie
 * or a session never authorizes a cross-origin call.
 */
export function isConsoleCrossOriginBearerCall(request: Request, access: ConsoleAccess): boolean {
  return access.mode === "token"
    && listedOrigin(request.headers.get("origin")) !== undefined
    && /^Bearer\s+\S+/i.test(request.headers.get("authorization") ?? "")
}

function corsHeaders(origin: string): Record<string, string> {
  return { "access-control-allow-origin": origin, "vary": "Origin" }
}

/**
 * Answer a CORS preflight to a Console data route. A Nitro middleware calls it before app middleware and app Auth, which
 * would reject a preflight because it has no credentials. A listed origin gets `204`; another origin gets `403`.
 * Returns `undefined` for every other request.
 */
export function answerConsolePreflight(event: ConsoleRequestEvent): Response | undefined {
  if (method(event) !== "OPTIONS") return undefined
  const origin = header(event, "origin")
  if (!origin || !header(event, "access-control-request-method")) return undefined
  const path = pathname(event)
  if (!dataRoutes.some(route => path.endsWith(route))) return undefined
  const allowed = listedOrigin(origin)
  if (!allowed) {
    return Response.json({ ...consoleDiagnosticBody("CONSOLE_ORIGIN_NOT_ALLOWED", `${origin} is not in console.origins for this app.`), ok: false, status: 403 }, {
      headers: { "cache-control": "no-store", "vary": "Origin", "x-content-type-options": "nosniff" },
      status: 403,
    })
  }
  return new Response(null, {
    headers: {
      ...corsHeaders(allowed),
      "access-control-allow-headers": consoleCorsAllowedHeaders,
      "access-control-allow-methods": "POST",
      "access-control-max-age": "600",
      "cache-control": "no-store",
      "vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    },
    status: 204,
  })
}

function withHeaders(response: Response, origin: string | undefined): Response {
  const challenge = response.status === 401 && !response.headers.has("www-authenticate")
  if (!origin && !challenge) return response
  // A Response from a fetch or from another realm can have immutable headers, so copy it.
  const copy = new Response(response.body, response)
  if (challenge) copy.headers.set("www-authenticate", consoleBearerChallenge())
  if (origin) for (const [name, value] of Object.entries(corsHeaders(origin))) copy.headers.set(name, value)
  return copy
}

function errorResponse(error: unknown): Response {
  const value = Object(error)
  const rawStatus = Reflect.get(value, "statusCode") ?? Reflect.get(value, "status")
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500
  const code: unknown = Reflect.get(value, "code")
  const message: unknown = Reflect.get(value, "statusMessage")
  // Server failures keep their details out of the response, as the Console RPC does.
  const body = consoleDiagnosticBody(isConsoleDiagnosticCode(code) ? code : consoleStatusDiagnosticCode(status), status < 500 && String(message) === message ? message : undefined)
  return Response.json({ ...body, ok: false, status }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" }, status })
}

/**
 * Wrap a Console data route. A `401` gets `WWW-Authenticate: Bearer realm="vitehub-console"` when the route set no
 * challenge. A request from a listed origin gets `Access-Control-Allow-Origin` with that origin and `Vary: Origin`,
 * also on failures, so the Console can read the diagnostic. No route sends `Access-Control-Allow-Credentials`.
 */
export function withConsoleCors<TEvent extends ConsoleRequestEvent, TResult>(
  handler: (event: TEvent) => Promise<TResult | Response>,
): (event: TEvent) => Promise<TResult | Response> {
  return async (event) => {
    const origin = listedOrigin(header(event, "origin"))
    let result: TResult | Response
    try {
      result = await handler(event)
    }
    catch (error) {
      // H3 builds its own response for a thrown error, without the CORS headers. Only a listed origin needs them.
      if (!origin) throw error
      return withHeaders(errorResponse(error), origin)
    }
    if (isRuntimeResponse(result)) return withHeaders(result, origin)
    if (origin) {
      for (const [name, value] of Object.entries(corsHeaders(origin))) {
        event.res?.headers?.set(name, value)
        event.node?.res?.setHeader(name, value)
      }
    }
    return result
  }
}
